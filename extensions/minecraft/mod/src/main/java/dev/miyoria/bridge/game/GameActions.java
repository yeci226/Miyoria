package dev.miyoria.bridge.game;

import com.google.gson.JsonObject;
import dev.miyoria.bridge.protocol.Protocol;
import dev.miyoria.bridge.protocol.ProtocolException;
import dev.miyoria.bridge.protocol.Request;
import dev.miyoria.bridge.util.Ids;
import dev.miyoria.bridge.util.LookMath;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayNetworkHandler;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.client.util.InputUtil;
import net.minecraft.block.BlockState;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.BlockItem;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.screen.slot.Slot;
import net.minecraft.screen.slot.SlotActionType;
import net.minecraft.util.ActionResult;
import net.minecraft.util.Hand;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Box;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Low-level player actions (look / use / attack / hotbar / place / chat / respawn) plus the
 * per-tick state they need (smooth camera, timed key holds). Client thread only.
 */
public final class GameActions {
    /** Max camera speed in degrees per tick when smoothing (20 ticks/s => ~600 deg/s is a quick flick). */
    private static final float SMOOTH_DEG_PER_TICK = 24f;
    private static final int MAX_HOLD_TICKS = 20 * 60;
    private static final int MAX_CHAT_LENGTH = 256;

    private Float targetYaw;
    private Float targetPitch;
    private final Map<KeyBinding, Integer> holds = new LinkedHashMap<>();

    // ------------------------------------------------------------------ per tick

    public void tick(MinecraftClient mc) {
        ClientPlayerEntity p = mc.player;
        if (p == null) {
            targetYaw = targetPitch = null;
            holds.clear();
            return;
        }
        if (targetYaw != null && targetPitch != null) {
            float yaw = LookMath.approachAngle(p.getYaw(), targetYaw, SMOOTH_DEG_PER_TICK);
            float pitch = LookMath.approachAngle(p.getPitch(), targetPitch, SMOOTH_DEG_PER_TICK);
            p.setYaw(yaw);
            p.setPitch(LookMath.clampPitch(pitch));
            if (yaw == targetYaw && pitch == targetPitch) {
                targetYaw = targetPitch = null;
            }
        }
        var it = holds.entrySet().iterator();
        while (it.hasNext()) {
            var en = it.next();
            int left = en.getValue() - 1;
            if (left <= 0) {
                en.getKey().setPressed(false);
                it.remove();
            } else {
                en.getKey().setPressed(true); // re-assert: focus changes can reset pressed states
                en.setValue(left);
            }
        }
    }

    /** A timed key hold ({@code use} / {@code attack} with {@code hold_ticks}) is running. */
    public boolean holding() {
        return !holds.isEmpty();
    }

    public void releaseAll() {
        targetYaw = targetPitch = null;
        for (KeyBinding k : holds.keySet()) k.setPressed(false);
        holds.clear();
    }

    // ------------------------------------------------------------------ actions

    public JsonObject look(MinecraftClient mc, Request req) throws ProtocolException {
        ClientPlayerEntity p = mc.player;
        float yaw;
        float pitch;
        var at = req.optObj("at");
        if (at != null) {
            double x = numOf(at, "x"), y = numOf(at, "y"), z = numOf(at, "z");
            Vec3d eye = p.getEyePos();
            LookMath.Rotation r = LookMath.toward(x - eye.x, y - eye.y, z - eye.z);
            yaw = r.yaw();
            pitch = r.pitch();
        } else if (req.has("yaw") || req.has("pitch")) {
            yaw = req.has("yaw") ? LookMath.wrapDegrees((float) req.num("yaw")) : p.getYaw();
            pitch = req.has("pitch") ? LookMath.clampPitch((float) req.num("pitch")) : p.getPitch();
        } else {
            throw new ProtocolException(Protocol.E_INVALID_ARGS, "look needs {yaw,pitch} or {at:{x,y,z}}");
        }
        boolean smooth = req.optBool("smooth", true);
        turn(p, yaw, pitch, smooth);
        JsonObject out = new JsonObject();
        out.addProperty("yaw", Math.round(yaw * 10f) / 10.0);
        out.addProperty("pitch", Math.round(pitch * 10f) / 10.0);
        out.addProperty("smooth", smooth);
        return out;
    }

    /** Turns the camera toward a world point (used by crafting and placing, which face what they touch). */
    public void lookAt(ClientPlayerEntity p, Vec3d at, boolean smooth) {
        Vec3d eye = p.getEyePos();
        LookMath.Rotation r = LookMath.toward(at.x - eye.x, at.y - eye.y, at.z - eye.z);
        turn(p, r.yaw(), r.pitch(), smooth);
    }

    private void turn(ClientPlayerEntity p, float yaw, float pitch, boolean smooth) {
        if (smooth) {
            targetYaw = yaw;
            targetPitch = pitch;
        } else {
            targetYaw = targetPitch = null;
            p.setYaw(yaw);
            p.setPitch(pitch);
        }
    }

    private static double numOf(com.google.gson.JsonObject o, String key) throws ProtocolException {
        var e = o.get(key);
        if (e == null || !e.isJsonPrimitive() || !e.getAsJsonPrimitive().isNumber()) {
            throw new ProtocolException(Protocol.E_INVALID_ARGS, "\"at." + key + "\" must be a number");
        }
        return e.getAsDouble();
    }

    /** Right click (use item / place block / interact). {@code hold_ticks} > 0 holds the button (eating, bows). */
    public JsonObject use(MinecraftClient mc, Request req) throws ProtocolException {
        return press(mc.options.useKey, req, "use");
    }

    /** Left click (attack / start breaking). {@code hold_ticks} > 0 holds it (mining a block). */
    public JsonObject attack(MinecraftClient mc, Request req) throws ProtocolException {
        return press(mc.options.attackKey, req, "attack");
    }

    private JsonObject press(KeyBinding key, Request req, String what) throws ProtocolException {
        int hold = Math.max(0, Math.min(MAX_HOLD_TICKS, req.optInt("hold_ticks", 0)));
        if (hold > 0) {
            key.setPressed(true);
            holds.put(key, hold);
        } else {
            // a single click, exactly like a physical key press this tick
            KeyBinding.onKeyPressed(InputUtil.fromTranslationKey(key.getBoundKeyTranslationKey()));
        }
        JsonObject out = new JsonObject();
        out.addProperty("action", what);
        out.addProperty("hold_ticks", hold);
        return out;
    }

    /** {@code {"slot":0-8}} or {@code {"item":"diamond_pickaxe"}} (first hotbar slot holding it). */
    public JsonObject selectSlot(MinecraftClient mc, Request req) throws ProtocolException {
        PlayerInventory inv = mc.player.getInventory();
        int slot;
        if (req.has("slot")) {
            slot = req.optInt("slot", -1);
            if (slot < 0 || slot > 8) throw new ProtocolException(Protocol.E_INVALID_ARGS, "slot must be 0-8");
        } else if (req.has("item")) {
            String want = Ids.qualify(req.str("item").toLowerCase());
            slot = -1;
            for (int i = 0; i < 9; i++) {
                ItemStack s = inv.main.get(i);
                if (!s.isEmpty() && Registries.ITEM.getId(s.getItem()).toString().equals(want)) {
                    slot = i;
                    break;
                }
            }
            if (slot < 0) throw new ProtocolException(Protocol.E_INVALID_ARGS, "no \"" + req.str("item") + "\" in the hotbar");
        } else {
            throw new ProtocolException(Protocol.E_INVALID_ARGS, "select_slot needs \"slot\" (0-8) or \"item\"");
        }
        inv.selectedSlot = slot;
        JsonObject out = new JsonObject();
        out.addProperty("slot", slot);
        ItemStack held = inv.getStack(slot);
        out.addProperty("item", held.isEmpty() ? null : Ids.normalize(Registries.ITEM.getId(held.getItem()).toString()));
        return out;
    }

    /**
     * {@code {"item":"crafting_table"}}: puts that block down on the ground next to her, the
     * direction she faces first. From the storage part of the inventory it is first swapped into
     * the selected hotbar slot (a hotbar-swap click, as a player would do).
     */
    public JsonObject place(MinecraftClient mc, Request req) throws ProtocolException {
        ClientPlayerEntity p = mc.player;
        Item item = Workbench.item(req.str("item"));
        if (!(item instanceof BlockItem)) {
            throw new ProtocolException(Protocol.E_INVALID_ARGS, Workbench.id(item) + " is not a block that can be placed");
        }
        if (mc.currentScreen != null) throw new ProtocolException(Protocol.E_INVALID_ARGS, "a screen is open; close it first");
        PlayerInventory inv = p.getInventory();
        int slot = -1;
        for (int i = 0; i < inv.main.size(); i++) {
            if (inv.main.get(i).isOf(item)) {
                slot = i;
                break;
            }
        }
        if (slot < 0) throw new ProtocolException(Protocol.E_MISSING_ITEMS, "missing " + Workbench.id(item) + " x1");
        BlockPos spot = placeSpot(p, mc.world);
        if (spot == null) {
            throw new ProtocolException(Protocol.E_INVALID_ARGS, "no free spot with solid ground right next to her");
        }
        if (slot < 9) {
            inv.selectedSlot = slot;
        } else {
            // player screen handler slots 9-35 are inventory slots 9-35; SWAP's button is the hotbar slot
            mc.interactionManager.clickSlot(p.playerScreenHandler.syncId, slot, inv.selectedSlot, SlotActionType.SWAP, p);
        }
        Vec3d top = new Vec3d(spot.getX() + 0.5, spot.getY(), spot.getZ() + 0.5);
        lookAt(p, top, true);
        ActionResult r = mc.interactionManager.interactBlock(p, Hand.MAIN_HAND, new BlockHitResult(top, Direction.UP, spot.down(), false));
        if (!r.isAccepted()) throw new ProtocolException(Protocol.E_INVALID_ARGS, "the game refused to place it there");
        p.swingHand(Hand.MAIN_HAND);
        JsonObject out = new JsonObject();
        out.addProperty("item", Workbench.id(item));
        JsonObject at = new JsonObject();
        at.addProperty("x", spot.getX());
        at.addProperty("y", spot.getY());
        at.addProperty("z", spot.getZ());
        out.add("position", at);
        return out;
    }

    /**
     * Drops item(s) from inventory.
     * {@code {"slot":0-35}} or {@code {"item":"cobblestone"}} or current selected hotbar slot.
     * {@code {"all":true}} (default true) drops whole stack, false drops 1 item.
     */
    public JsonObject drop(MinecraftClient mc, Request req) throws ProtocolException {
        ClientPlayerEntity p = mc.player;
        if (p == null) throw new ProtocolException(Protocol.E_NOT_IN_GAME, "not in game");
        if (p.isDead()) throw new ProtocolException(Protocol.E_INVALID_ARGS, "she is dead");
        if (mc.currentScreen != null) throw new ProtocolException(Protocol.E_INVALID_ARGS, "a screen is open; close it first");

        PlayerInventory inv = p.getInventory();
        int slot = -1;
        boolean all = req.optBool("all", true);
        if (req.has("slot")) {
            slot = req.optInt("slot", -1);
            if (slot < 0 || slot > 35) throw new ProtocolException(Protocol.E_INVALID_ARGS, "slot must be 0-35");
        } else if (req.has("item")) {
            String want = Ids.qualify(req.str("item").toLowerCase());
            for (int i = 0; i < inv.main.size(); i++) {
                ItemStack s = inv.main.get(i);
                if (!s.isEmpty() && Registries.ITEM.getId(s.getItem()).toString().equals(want)) {
                    slot = i;
                    break;
                }
            }
            if (slot < 0) throw new ProtocolException(Protocol.E_MISSING_ITEMS, "no \"" + req.str("item") + "\" in inventory");
        } else {
            slot = inv.selectedSlot;
        }

        ItemStack targetStack = inv.main.get(slot);
        if (targetStack.isEmpty()) {
            JsonObject out = new JsonObject();
            out.addProperty("slot", slot);
            out.addProperty("count", 0);
            return out;
        }

        String itemId = Ids.normalize(Registries.ITEM.getId(targetStack.getItem()).toString());
        int countBefore = targetStack.getCount();

        if (slot < 9 && slot == inv.selectedSlot) {
            p.dropSelectedItem(all);
        } else {
            int handlerSlot = -1;
            for (Slot s : p.playerScreenHandler.slots) {
                if (s.inventory == inv && s.getIndex() == slot) {
                    handlerSlot = s.id;
                    break;
                }
            }
            if (handlerSlot >= 0 && mc.interactionManager != null) {
                mc.interactionManager.clickSlot(p.playerScreenHandler.syncId, handlerSlot, all ? 1 : 0, SlotActionType.THROW, p);
            } else if (slot < 9) {
                inv.selectedSlot = slot;
                p.dropSelectedItem(all);
            }
        }

        JsonObject out = new JsonObject();
        out.addProperty("slot", slot);
        out.addProperty("item", itemId);
        out.addProperty("count", all ? countBefore : 1);
        return out;
    }

    /**
     * An empty space beside her feet with a plain solid block under it (not one that opens a
     * screen when clicked, or the click would open it instead of placing).
     */
    private static BlockPos placeSpot(ClientPlayerEntity p, ClientWorld w) {
        Direction facing = p.getHorizontalFacing();
        Direction[] order = {facing, facing.rotateYClockwise(), facing.rotateYCounterclockwise(), facing.getOpposite()};
        BlockPos feet = p.getBlockPos();
        for (int reach = 1; reach <= 2; reach++) {
            for (Direction d : order) {
                BlockPos spot = feet.offset(d, reach);
                BlockPos below = spot.down();
                BlockState under = w.getBlockState(below);
                if (!w.getBlockState(spot).isReplaceable()) continue;
                if (!under.isSolidBlock(w, below) || under.createScreenHandlerFactory(w, below) != null) continue;
                if (p.getBoundingBox().intersects(new Box(spot))) continue;
                return spot;
            }
        }
        return null;
    }

    /** Chat message, or a slash command when it starts with "/". */
    public JsonObject chat(MinecraftClient mc, Request req) throws ProtocolException {
        String msg = req.str("message").strip();
        if (msg.isEmpty() || msg.length() > MAX_CHAT_LENGTH) {
            throw new ProtocolException(Protocol.E_INVALID_ARGS, "message must be 1-" + MAX_CHAT_LENGTH + " chars");
        }
        ClientPlayNetworkHandler net = mc.getNetworkHandler();
        if (net == null) throw new ProtocolException(Protocol.E_NOT_IN_GAME, "not connected");
        if (msg.startsWith("/")) {
            net.sendChatCommand(msg.substring(1));
        } else {
            net.sendChatMessage(msg);
        }
        JsonObject out = new JsonObject();
        out.addProperty("sent", msg);
        return out;
    }

    public JsonObject respawn(MinecraftClient mc) {
        JsonObject out = new JsonObject();
        boolean dead = mc.player.isDead();
        if (dead) mc.player.requestRespawn();
        out.addProperty("respawned", dead);
        return out;
    }
}
