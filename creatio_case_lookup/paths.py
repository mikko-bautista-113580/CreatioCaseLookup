"""Project-relative locations, anchored on this package's parent directory.

Everything the app reads or writes lives under the project root: the `.env`
file, the git-ignored `.analysis/` store, the static UI and the browser
profile used for SSO login. Anchoring on the package (not the working
directory) means the MCP server, the web app and the CLI all agree no matter
where they are launched from.
"""

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = PROJECT_ROOT / ".env"
ANALYSIS_DIR = PROJECT_ROOT / ".analysis"
PUBLIC_DIR = PROJECT_ROOT / "public"
PROFILE_DIR = PROJECT_ROOT / ".browser-profile"
