"""BS-RoFormer, the inference half, vendored beside ``melband.py`` (whose building blocks it shares).

Used by ``leadsplit.py`` for the BS-RoFormer karaoke checkpoints (becruily & Frazer, anvuew). The
model is the Band-Split RoFormer of Lu et al. (arXiv 2309.02612) as implemented by lucidrains
(``BS-RoFormer``, MIT) and adapted by ZFTurbo (``Music-Source-Separation-Training``, MIT). Only the
forward pass is kept (no training loss, linear attention, checkpointing or skip connections), so
the published state dicts load unchanged as long as their config does not ask for those.
"""
from functools import partial

import torch
from beartype import beartype
from beartype.typing import Callable, Optional, Tuple
from einops import pack, rearrange, unpack
from rotary_embedding_torch import RotaryEmbedding
from torch import nn
from torch.nn import Module, ModuleList

from melband import BandSplit, RMSNorm, Transformer, default, pack_one, unpack_one


def MLP(dim_in, dim_out, dim_hidden=None, depth=1, activation=nn.Tanh):
    """As melband's, except ``depth`` counts the layers (BS-RoFormer's checkpoints have one hidden
    layer fewer than MelBand's for the same depth)."""
    dim_hidden = default(dim_hidden, dim_in)
    net = []
    dims = (dim_in, *((dim_hidden,) * (depth - 1)), dim_out)
    for ind, (layer_dim_in, layer_dim_out) in enumerate(zip(dims[:-1], dims[1:])):
        net.append(nn.Linear(layer_dim_in, layer_dim_out))
        if ind < len(dims) - 2:
            net.append(activation())
    return nn.Sequential(*net)


class MaskEstimator(Module):
    @beartype
    def __init__(self, dim, dim_inputs: Tuple[int, ...], depth, mlp_expansion_factor=4):
        super().__init__()
        self.dim_inputs = dim_inputs
        self.to_freqs = ModuleList([])
        dim_hidden = dim * mlp_expansion_factor
        for dim_in in dim_inputs:
            self.to_freqs.append(nn.Sequential(
                MLP(dim, dim_in * 2, dim_hidden=dim_hidden, depth=depth),
                nn.GLU(dim=-1),
            ))

    def forward(self, x):
        return torch.cat([mlp(band) for band, mlp in zip(x.unbind(dim=-2), self.to_freqs)], dim=-1)


class BSRoformer(Module):

    @beartype
    def __init__(
            self,
            dim,
            *,
            depth,
            stereo=False,
            num_stems=1,
            time_transformer_depth=2,
            freq_transformer_depth=2,
            linear_transformer_depth=0,
            freqs_per_bands: Tuple[int, ...] = (),
            dim_head=64,
            heads=8,
            attn_dropout=0.,
            ff_dropout=0.,
            flash_attn=True,
            dim_freqs_in=1025,
            stft_n_fft=2048,
            stft_hop_length=512,
            stft_win_length=2048,
            stft_normalized=False,
            stft_window_fn: Optional[Callable] = None,
            mask_estimator_depth=2,
            mlp_expansion_factor=4,
            **_training_only,  # multi-resolution STFT loss settings and the like
    ):
        super().__init__()
        if linear_transformer_depth:
            raise ValueError("linear attention layers are not supported by this inference copy")
        self.stereo = stereo
        self.audio_channels = 2 if stereo else 1
        self.layers = ModuleList([])
        transformer_kwargs = dict(dim=dim, heads=heads, dim_head=dim_head, attn_dropout=attn_dropout,
                                  ff_dropout=ff_dropout, flash_attn=flash_attn, norm_output=False)
        time_rotary_embed = RotaryEmbedding(dim=dim_head)
        freq_rotary_embed = RotaryEmbedding(dim=dim_head)
        for _ in range(depth):
            self.layers.append(ModuleList([
                Transformer(depth=time_transformer_depth, rotary_embed=time_rotary_embed, **transformer_kwargs),
                Transformer(depth=freq_transformer_depth, rotary_embed=freq_rotary_embed, **transformer_kwargs),
            ]))
        self.final_norm = RMSNorm(dim)
        self.stft_kwargs = dict(n_fft=stft_n_fft, hop_length=stft_hop_length, win_length=stft_win_length,
                                normalized=stft_normalized)
        self.stft_window_fn = partial(default(stft_window_fn, torch.hann_window), stft_win_length)
        freqs = stft_n_fft // 2 + 1
        if len(freqs_per_bands) < 2 or sum(freqs_per_bands) != freqs:
            raise ValueError(f"the bands must cover the {freqs} STFT bins, got {sum(freqs_per_bands)}")
        freqs_per_bands_with_complex = tuple(2 * f * self.audio_channels for f in freqs_per_bands)
        self.band_split = BandSplit(dim=dim, dim_inputs=freqs_per_bands_with_complex)
        self.mask_estimators = ModuleList([
            MaskEstimator(dim=dim, dim_inputs=freqs_per_bands_with_complex, depth=mask_estimator_depth,
                          mlp_expansion_factor=mlp_expansion_factor)
            for _ in range(num_stems)
        ])

    def forward(self, raw_audio):
        """(batch, channels, samples) → the stem(s), the same shape (``num_stems`` > 1 adds a dim)."""
        device = raw_audio.device
        if raw_audio.ndim == 2:
            raw_audio = rearrange(raw_audio, "b t -> b 1 t")
        channels = raw_audio.shape[1]
        if channels != self.audio_channels:
            raise ValueError(f"the model takes {self.audio_channels} channel(s), got {channels}")

        raw_audio, packed_shape = pack_one(raw_audio, "* t")
        window = self.stft_window_fn(device=device)
        stft_repr = torch.view_as_real(torch.stft(raw_audio, **self.stft_kwargs, window=window, return_complex=True))
        stft_repr = unpack_one(stft_repr, packed_shape, "* f t c")
        stft_repr = rearrange(stft_repr, "b s f t c -> b (f s) t c")

        x = rearrange(stft_repr, "b f t c -> b t (f c)")
        x = self.band_split(x)
        for time_transformer, freq_transformer in self.layers:
            x = rearrange(x, "b t f d -> b f t d")
            x, ps = pack([x], "* t d")
            x = time_transformer(x)
            x, = unpack(x, ps, "* t d")
            x = rearrange(x, "b f t d -> b t f d")
            x, ps = pack([x], "* f d")
            x = freq_transformer(x)
            x, = unpack(x, ps, "* f d")
        x = self.final_norm(x)

        num_stems = len(self.mask_estimators)
        mask = torch.stack([fn(x) for fn in self.mask_estimators], dim=1)
        mask = rearrange(mask, "b n t (f c) -> b n f t c", c=2)
        stft_repr = rearrange(stft_repr, "b f t c -> b 1 f t c")
        stft_repr = torch.view_as_complex(stft_repr) * torch.view_as_complex(mask.float().contiguous())
        stft_repr = rearrange(stft_repr, "b n (f s) t -> (b n s) f t", s=self.audio_channels)
        recon = torch.istft(stft_repr, **self.stft_kwargs, window=window, return_complex=False,
                            length=raw_audio.shape[-1])
        recon = rearrange(recon, "(b n s) t -> b n s t", s=self.audio_channels, n=num_stems)
        if num_stems == 1:
            recon = rearrange(recon, "b 1 s t -> b s t")
        return recon
