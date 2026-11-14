"""Export WRITEUP.md to an A4 PDF with Edge/Chrome headless.
Usage: pip install markdown && python scripts/export-writeup.py WRITEUP.md WRITEUP.pdf"""
import os, shutil, subprocess, sys, pathlib
import markdown

src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
text = src.read_text(encoding="utf-8")
# Drop the drafting note (first blockquote) from the exported PDF.
lines = [l for l in text.splitlines() if not l.startswith("> Fill the")]
body = markdown.markdown("\n".join(lines), extensions=["tables", "fenced_code", "sane_lists"])
html = f"""<!doctype html><html><head><meta charset="utf-8"><style>
@page {{ size: A4; margin: 14mm 15mm; }}
body {{ font: 9.6pt/1.38 "Segoe UI", Arial, sans-serif; color: #111; }}
h1 {{ font-size: 15pt; margin: 0 0 6px; }}
h2 {{ font-size: 11.5pt; margin: 10px 0 3px; border-bottom: 1px solid #ccc; padding-bottom: 1px; }}
p, li {{ margin: 2px 0; }} ul {{ margin: 2px 0 2px 18px; padding: 0; }}
code {{ font: 8.6pt Consolas, monospace; background: #f2f2f2; padding: 0 2px; }}
table {{ border-collapse: collapse; width: 100%; font-size: 8.8pt; margin: 4px 0; }}
th, td {{ border: 1px solid #bbb; padding: 2px 5px; text-align: left; vertical-align: top; }}
th {{ background: #eee; }}
</style></head><body>{body}</body></html>"""
tmp = out.with_suffix(".html")
tmp.write_text(html, encoding="utf-8")
edge = next((p for p in [r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", r"C:\Program Files\Google\Chrome\Application\chrome.exe", shutil.which("chromium") or "", shutil.which("google-chrome") or ""] if p and os.path.exists(p)), None)
if not edge:
    sys.exit("Edge or Chrome is required for the PDF export")
subprocess.run([edge, "--headless", "--disable-gpu", "--no-pdf-header-footer",
                f"--print-to-pdf={out.resolve()}", tmp.resolve().as_uri()], check=True, timeout=60)
print("wrote", out)
