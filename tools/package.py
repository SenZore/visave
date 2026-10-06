from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parents[1]
destination = root / "dist" / "visave-source.zip"
destination.parent.mkdir(exist_ok=True)
excluded = {"node_modules", ".venv", "__pycache__", "generated", ".git", "test-results"}
files = [root / name for name in ("README.md", "LICENSE", "SECURITY.md", "CONTRIBUTING.md", "INSTALLATION-PLAN.md", "START-HERE.html", "install.ps1", "package.json", "package-lock.json", ".gitignore")]
for directory in ("extension", "native", "tests", "tools", "setup", "docs", ".github"):
    files.extend(file for file in (root / directory).rglob("*") if file.is_file() and not excluded.intersection(file.relative_to(root).parts) and file.suffix != ".pyc" and file.name not in ("video-lens-host.cmd", "com.videolens.downloader.json"))
with ZipFile(destination, "w", ZIP_DEFLATED) as archive:
    for file in files:
        if file.exists():
            archive.write(file, file.relative_to(root).as_posix())
print(destination)
