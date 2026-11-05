#!/bin/sh
# Untangle installer.
#
# WHAT THIS SCRIPT DOES AND, MORE IMPORTANTLY, WHAT IT DOES NOT
#
# It does exactly one thing: it checks whether this machine can run Untangle,
# and then calls npm. It downloads no binary of its own, unpacks no archive,
# writes nothing outside npm's global prefix, and touches no shell profile.
# Everything it installs comes from the npm registry, whose integrity npm
# verifies against the tarball hash recorded in the registry metadata.
#
# THE LIMIT IT CANNOT CLOSE — SAID PLAINLY
#
# If you ran this as `curl ... | sh`, you executed this script before you could
# check it. No line inside a script can fix that: a script cannot vouch for
# itself, because a tampered copy would simply carry a tampered check. The only
# real answer is to download it, verify it, and then run it:
#
#   curl -fsSLo untangle-install.sh <url>
#   shasum -a 256 untangle-install.sh     # compare against the published value
#   sh untangle-install.sh
#
# The README states the same limit; it is not hidden in a comment.
#
# WHY IT REFUSES INSTEAD OF IMPROVISING
#
# When a precondition fails, this script names exactly one next step and stops.
# It never installs a Node version manager, never edits PATH, never falls back
# to a different package manager. A tool that quietly does something other than
# what was asked is worse than one that stops and explains.

set -eu

PACKAGE_NAME="@untangle-code/cli"
REQUIRED_NODE_MAJOR=22
REQUIRED_NODE_MINOR=13
NODE_DOWNLOAD_URL="https://nodejs.org/en/download"

VERSION=""
DRY_RUN=0

say() {
  # Diagnostics go to stderr so that a caller can capture the resolved command.
  printf '%s\n' "$*" >&2
}

die() {
  # One problem, one next step. Never a list of maybes.
  say ""
  say "untangle install: $1"
  say "Next step: $2"
  exit 1
}

usage() {
  cat <<'USAGE'
untangle install — install the Untangle CLI from npm

Usage:
  sh install.sh [--version <v>] [--dry-run] [--help]

Options:
  --version <v>  Install this exact version instead of the newest one.
  --dry-run      Run every check and print the npm command, install nothing.
  --help         Show this text.

The script installs nothing but the npm package. It requires Node.js 22 (>= 22.13) or >= 24
and npm to be present already; if either is missing it says so and stops.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      [ $# -ge 2 ] || die "--version needs a value." "Write --version 0.1.0"
      VERSION="$2"
      shift 2
      ;;
    --version=*)
      VERSION="${1#--version=}"
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "Unknown option \"$1\"." "Run: sh install.sh --help"
      ;;
  esac
done

# --- 1. platform --------------------------------------------------------------
# Untangle is a Node program, so the constraint is really "does Node.js support
# this platform". The check is here anyway, because a clear refusal beats an
# npm error three screens long.

OS="$(uname -s 2>/dev/null || echo unknown)"
ARCH="$(uname -m 2>/dev/null || echo unknown)"

case "$OS" in
  Linux | Darwin) ;;
  MINGW* | MSYS* | CYGWIN* | Windows_NT)
    die "This shell script does not support Windows ($OS)." \
      "Open PowerShell and run: npm install --global $PACKAGE_NAME"
    ;;
  *)
    die "Unsupported operating system \"$OS\"." \
      "Install Node.js >= ${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR} yourself, then run: npm install --global $PACKAGE_NAME"
    ;;
esac

case "$ARCH" in
  x86_64 | amd64 | arm64 | aarch64) ;;
  *)
    die "Unsupported CPU architecture \"$ARCH\"; Node.js publishes no official build for it." \
      "Build Node.js >= ${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR} for $ARCH, then run: npm install --global $PACKAGE_NAME"
    ;;
esac

say "untangle install: platform $OS/$ARCH — supported."

# --- 2. Node.js ---------------------------------------------------------------
# Keep this check aligned with package.json: ^22.13.0 || >=24.0.0.
# The locked ESLint dependencies require 22.13 on the 22.x line and do not
# support 23.x, so the install and development paths use the same contract.

if ! command -v node >/dev/null 2>&1; then
  die "Node.js is not installed (no \"node\" on PATH)." \
    "Install Node.js >= ${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR} from $NODE_DOWNLOAD_URL, then run this script again."
fi

NODE_VERSION_RAW="$(node --version 2>/dev/null || echo "")"
[ -n "$NODE_VERSION_RAW" ] || die "\"node --version\" produced no output." \
  "Repair the Node.js installation, then run this script again."

NODE_VERSION="${NODE_VERSION_RAW#v}"
NODE_MAJOR="${NODE_VERSION%%.*}"
NODE_REST="${NODE_VERSION#*.}"
NODE_MINOR="${NODE_REST%%.*}"

case "$NODE_MAJOR" in
  '' | *[!0-9]*)
    die "Cannot read the Node.js version from \"$NODE_VERSION_RAW\"." \
      "Install Node.js >= ${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR} from $NODE_DOWNLOAD_URL, then run this script again."
    ;;
esac
case "$NODE_MINOR" in
  '' | *[!0-9]*) NODE_MINOR=0 ;;
esac

NODE_TOO_OLD=0
if [ "$NODE_MAJOR" -lt "$REQUIRED_NODE_MAJOR" ]; then
  NODE_TOO_OLD=1
elif [ "$NODE_MAJOR" -eq "$REQUIRED_NODE_MAJOR" ] && [ "$NODE_MINOR" -lt "$REQUIRED_NODE_MINOR" ]; then
  NODE_TOO_OLD=1
fi

if [ "$NODE_TOO_OLD" -eq 1 ]; then
  die "Node.js $NODE_VERSION is too old; Untangle needs >= ${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR}." \
    "Upgrade Node.js (see $NODE_DOWNLOAD_URL), then run this script again."
fi

if [ "$NODE_MAJOR" -eq 23 ]; then
  die "Node.js $NODE_VERSION is unsupported; Untangle needs 22 (>= 22.13) or >= 24." \
    "Install a supported Node.js version from $NODE_DOWNLOAD_URL, then run this script again."
fi

say "untangle install: Node.js $NODE_VERSION — ok (22 >= 22.13 or >= 24)."

# --- 3. npm -------------------------------------------------------------------
# npm is what verifies the package tarball against the registry's integrity
# hash. This script deliberately does not fetch the tarball itself, because
# doing so would move that verification from npm to code written here.

if ! command -v npm >/dev/null 2>&1; then
  die "npm is not installed (no \"npm\" on PATH)." \
    "Install npm — it ships with Node.js from $NODE_DOWNLOAD_URL — then run this script again."
fi

say "untangle install: npm $(npm --version) — ok."

# --- 4. install ---------------------------------------------------------------

if [ -n "$VERSION" ]; then
  SPEC="${PACKAGE_NAME}@${VERSION}"
else
  SPEC="$PACKAGE_NAME"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  say "untangle install: dry run — nothing was installed."
  printf 'npm install --global %s\n' "$SPEC"
  exit 0
fi

say "untangle install: running: npm install --global $SPEC"
if ! npm install --global "$SPEC"; then
  die "npm could not install $SPEC." \
    "Read npm's error above; if it is a permission error, use a user-writable npm prefix (npm config set prefix ~/.local) instead of sudo."
fi

# --- 5. prove it ---------------------------------------------------------------
# An installer that ends without checking is an installer that reports success
# it did not verify.

if ! command -v untangle >/dev/null 2>&1; then
  die "The package installed, but \"untangle\" is not on PATH." \
    "Add npm's global bin directory to PATH: export PATH=\"\$(npm prefix --global)/bin:\$PATH\""
fi

say "untangle install: installed $(untangle --version) at $(command -v untangle)."
say "untangle install: next step — run: untangle init"
