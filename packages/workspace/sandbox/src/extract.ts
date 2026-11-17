// The program that turns a user-sent file into text, run inside the sandbox container (offline,
// read-only code, no privileges). Python standard library only, so it needs no packages in the
// image. It never executes anything from the file: text is decoded, Office files are read as ZIP
// + XML (no macros, no external entities, bounded), PDFs are scanned for text operators.
//
// stdin: `{"file": "input.bin", "kind": "text|docx|xlsx|pptx|pdf", "max_chars": 6000}`.
// stdout: one JSON object, `{"ok": true, "text": ..., "truncated": bool, "kind": ...}` or
// `{"ok": false, "reason": "empty|binary|corrupt|encrypted|too_complex|unsafe|unsupported"}`.
// The input file is deleted from `/work` before it exits.

export const EXTRACT_PROGRAM = String.raw`import sys, os, json, re, zlib, zipfile
from xml.etree import ElementTree as ET

req = json.loads(sys.stdin.read())
PATH = os.environ.get("EXTRACT_WORK", "/work") + "/" + req["file"]
KIND = req["kind"]
MAX = int(req["max_chars"])
CAP = 20 * 1024 * 1024


def done(**kw):
    sys.stdout.write(json.dumps(kw))
    sys.exit(0)


def fail(why):
    done(ok=False, reason=why)


class Acc:
    def __init__(self):
        self.parts = []
        self.n = 0
        self.total = 0

    def add(self, t):
        self.total += len(t) + 1
        if self.n < MAX:
            t = t[: MAX - self.n]
            self.parts.append(t)
            self.n += len(t) + 1

    @property
    def full(self):
        return self.n >= MAX

    def finish(self):
        text = "\n".join(self.parts).strip()
        if not text:
            fail("empty")
        done(ok=True, text=text, truncated=self.total > MAX + 1, kind=KIND)


def decode(b):
    if b.startswith(b"\xef\xbb\xbf"):
        return b[3:].decode("utf-8", "replace")
    if b[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return b.decode("utf-16", "replace")
    if b"\x00" in b[:8192]:
        fail("binary")
    s = None
    for enc in ("utf-8", "big5", "gb18030"):
        try:
            s = b.decode(enc)
            break
        except UnicodeDecodeError:
            pass
    if s is None:
        s = b.decode("latin-1")
    head = s[:4096]
    bad = sum(1 for c in head if ord(c) < 32 and c not in "\n\r\t\f")
    if head and bad / len(head) > 0.05:
        fail("binary")
    return s


def text(data):
    a = Acc()
    for line in decode(data).replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        a.add(line.rstrip())
        if a.full:
            break
    a.finish()


def zopen():
    try:
        z = zipfile.ZipFile(PATH)
    except Exception:
        fail("corrupt")
    infos = z.infolist()
    if len(infos) > 1000 or sum(i.file_size for i in infos) > 200 * 1024 * 1024:
        fail("too_complex")
    return z


def xml(z, name):
    try:
        with z.open(name) as f:
            b = f.read(CAP + 1)
    except Exception:
        return None
    if len(b) > CAP:
        fail("too_complex")
    if b"<!DOCTYPE" in b or b"<!ENTITY" in b:
        fail("unsafe")
    try:
        return ET.fromstring(b)
    except ET.ParseError:
        fail("corrupt")


def num(name):
    m = re.search(r"(\d+)\.xml$", name)
    return int(m.group(1)) if m else 0


def docx():
    z = zopen()
    root = xml(z, "word/document.xml")
    if root is None:
        fail("corrupt")
    W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    a = Acc()
    for p in root.iter(W + "p"):
        a.add("".join(t.text or "" for t in p.iter(W + "t")))
        if a.full:
            break
    a.finish()


def xlsx():
    z = zopen()
    N = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    shared = []
    sst = xml(z, "xl/sharedStrings.xml")
    if sst is not None:
        for si in sst.iter(N + "si"):
            shared.append("".join(t.text or "" for t in si.iter(N + "t")))
    sheets = sorted(
        (n for n in z.namelist() if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n)), key=num
    )
    a = Acc()
    for name in sheets:
        root = xml(z, name)
        a.add("--- sheet %d ---" % num(name))
        for row in root.iter(N + "row"):
            cells = []
            for c in row.iter(N + "c"):
                t = c.get("t")
                v = c.find(N + "v")
                if t == "inlineStr":
                    val = "".join(x.text or "" for x in c.iter(N + "t"))
                elif v is None or v.text is None:
                    val = ""
                elif t == "s":
                    try:
                        val = shared[int(v.text)]
                    except (ValueError, IndexError):
                        val = ""
                else:
                    val = v.text
                cells.append(val)
            a.add("\t".join(cells).rstrip())
            if a.full:
                break
        if a.full:
            break
    a.finish()


def pptx():
    z = zopen()
    A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
    slides = sorted(
        (n for n in z.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)), key=num
    )
    a = Acc()
    for name in slides:
        root = xml(z, name)
        a.add("--- slide %d ---" % num(name))
        for p in root.iter(A + "p"):
            a.add("".join(t.text or "" for t in p.iter(A + "t")))
        if a.full:
            break
    a.finish()


ESC = {b"n": b"\n", b"r": b"\r", b"t": b"\t", b"b": b"", b"f": b""}


def unescape(s):
    out = bytearray()
    i = 0
    while i < len(s):
        c = s[i : i + 1]
        if c == b"\\" and i + 1 < len(s):
            n = s[i + 1 : i + 2]
            if n in ESC:
                out += ESC[n]
                i += 2
            elif n.isdigit():
                m = re.match(rb"[0-7]{1,3}", s[i + 1 :])
                if m is None:
                    i += 2
                    continue
                out.append(int(m.group(0), 8) & 255)
                i += 1 + len(m.group(0))
            else:
                out += n
                i += 2
        else:
            out += c
            i += 1
    return out.decode("latin-1")


OPS = re.compile(
    rb"\[((?:[^\]\\]|\\.)*)\]\s*TJ|\(((?:[^\\)]|\\.)*)\)\s*(?:Tj|'|\")|\bET\b|\bT\*", re.S
)
STR = re.compile(rb"\(((?:[^\\)]|\\.)*)\)|(-?\d+(?:\.\d+)?)", re.S)


def pdf():
    # Best effort with the standard library: simple (non-CID) fonts only. Scanned pages and
    # most CJK documents have no text this finds.
    try:
        data = open(PATH, "rb").read(CAP + 1)
    except Exception:
        fail("corrupt")
    if not data.startswith(b"%PDF"):
        fail("corrupt")
    if b"/Encrypt" in data:
        fail("encrypted")
    a = Acc()
    seen = 0
    for m in re.finditer(rb"stream\r?\n", data):
        seen += 1
        if seen > 3000 or a.full:
            break
        end = data.find(b"endstream", m.end())
        if end < 0:
            continue
        head = data[max(0, m.start() - 400) : m.start()].rsplit(b"obj", 1)[-1]
        raw = data[m.end() : end]
        if b"/FlateDecode" in head:
            try:
                body = zlib.decompressobj().decompress(raw, 8 * 1024 * 1024)
            except zlib.error:
                continue
        elif b"/Filter" in head:
            continue
        else:
            body = raw
        if b"BT" not in body:
            continue
        line = []
        for op in OPS.finditer(body):
            if op.group(1) is not None:
                for s in STR.finditer(op.group(1)):
                    if s.group(1) is not None:
                        line.append(unescape(s.group(1)))
                    elif float(s.group(2)) < -200:
                        line.append(" ")
            elif op.group(2) is not None:
                line.append(unescape(op.group(2)))
            else:
                a.add("".join(line))
                line = []
        a.add("".join(line))
    a.parts = [p for p in a.parts if p.strip()]
    a.finish()


try:
    if KIND == "text":
        data = open(PATH, "rb").read(CAP + 1)
        if len(data) > CAP:
            fail("too_complex")
        text(data)
    elif KIND == "docx":
        docx()
    elif KIND == "xlsx":
        xlsx()
    elif KIND == "pptx":
        pptx()
    elif KIND == "pdf":
        pdf()
    else:
        fail("unsupported")
finally:
    try:
        os.remove(PATH)
    except OSError:
        pass
`;
