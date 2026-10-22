#!/usr/bin/env bash
# verificar-ambiente.sh - checks the lab environment of MEI.CDN (read-only).
#
# Usage:   bash verificar-ambiente.sh
# Output:  one line per result: [OK] ..., [FAIL] ... -> fix, [WARN] ... -> suggestion
#          last line: "RESULT: OK" or "RESULT: FAIL (<n> problem(s))"
# Exit:    0 when there is no [FAIL], 1 otherwise.
# It does not change the system and does not pull images.
#
# Optional variables:
#   CLUSTER_NAME   cluster to look for (default: cdn)
#   CLUSTER_PORT   host port of the cluster's load balancer (default: 8080)

if [ -z "${BASH_VERSION:-}" ]; then
  echo "[FAIL] shell: this script needs bash -> run: bash verificar-ambiente.sh"
  echo "RESULT: FAIL (1 problem(s))"
  exit 1
fi

CLUSTER_NAME="${CLUSTER_NAME:-cdn}"
CLUSTER_PORT="${CLUSTER_PORT:-8080}"
FAILS=0
IS_WSL=0
DOCKER_OK=0
HAVE_KUBECTL=0
HAVE_K3D=0

# ---- access to the system (small functions, so they can be replaced in tests) ----
sys_uname() { uname -s 2>/dev/null; }
sys_proc_version() { cat /proc/version 2>/dev/null; }
sys_pwd() { printf '%s\n' "$PWD"; }
sys_cmdpath() { command -v "$1" 2>/dev/null; }
sys_free_gb() { # free space in GB of the filesystem holding $1
  df -Pk "$1" 2>/dev/null | awk 'NR==2 && $4 ~ /^[0-9]+$/ {print int($4/1048576)}'
}
sys_fs_of() { df -P "$1" 2>/dev/null | awk 'NR==2 {print $1 " " $6}'; }

# run a command with a time limit when `timeout` exists
run_t() {
  local secs="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"; else "$@"; fi
}

# ---- output ----
ok() { echo "[OK] $*"; }
warn() { echo "[WARN] $*"; }
fail() {
  echo "[FAIL] $*"
  FAILS=$((FAILS + 1))
}

is_windows_binary() { # true for .exe or anything under /mnt/<drive>/ (not /mnt/wsl/)
  case "$1" in
    *.exe | *.EXE) return 0 ;;
    /mnt/wsl/*) return 1 ;;
    /mnt/[a-zA-Z]/*) return 0 ;;
  esac
  return 1
}

first_line() { sed -n '1p'; }

# ---- 1. shell and operating system ----
check_shell() {
  local un pv
  un="$(sys_uname)"
  pv="$(sys_proc_version)"
  case "$un" in
    MINGW* | MSYS* | CYGWIN*)
      fail "shell: Git Bash/MSYS/Cygwin detected ($un) -> use the Ubuntu (WSL2) terminal"
      echo "RESULT: FAIL ($FAILS problem(s))"
      exit 1
      ;;
    Linux)
      case "$pv" in
        *microsoft* | *WSL*)
          IS_WSL=1
          ok "shell: bash ${BASH_VERSION%%(*}, Ubuntu on WSL2"
          ;;
        *Microsoft*)
          IS_WSL=1
          fail "shell: this is WSL 1 -> in PowerShell run: wsl --set-version Ubuntu 2"
          ;;
        *) ok "shell: bash ${BASH_VERSION%%(*}, native Linux (supported)" ;;
      esac
      ;;
    Darwin) ok "shell: bash ${BASH_VERSION%%(*}, macOS (supported)" ;;
    *)
      fail "shell: unsupported system '$un' -> use the Ubuntu (WSL2) terminal"
      echo "RESULT: FAIL ($FAILS problem(s))"
      exit 1
      ;;
  esac
}

# ---- 2. working folder ----
check_folder() {
  local here
  here="$(sys_pwd)"
  if [ "$IS_WSL" -eq 1 ]; then
    case "$here" in
      /mnt/*) fail "folder: $here is on Windows disk -> move the lab folder to ~ (cd ~)" ;;
      *) ok "folder: $here (Linux filesystem)" ;;
    esac
  else
    ok "folder: $here"
  fi
}

# ---- 3. docker ----
check_docker() {
  local path info rc mem_b ncpu ver comp
  path="$(sys_cmdpath docker)"
  if [ -z "$path" ]; then
    if [ "$IS_WSL" -eq 1 ]; then
      fail "docker: command not found -> Docker Desktop > Settings > Resources > WSL Integration"
    else
      fail "docker: command not found -> install Docker Engine or Docker Desktop"
    fi
    return
  fi
  if is_windows_binary "$path"; then
    fail "docker: $path is a Windows program -> enable WSL Integration in Docker Desktop"
  else
    ok "docker: $path (Linux binary)"
  fi

  info="$(run_t 30 docker info --format '{{.MemTotal}} {{.NCPU}} {{.ServerVersion}}' 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    case "$info" in
      *"permission denied"*)
        fail "docker daemon: permission denied -> sudo usermod -aG docker \$USER, then log in again"
        ;;
      *)
        if [ "$IS_WSL" -eq 1 ]; then
          fail "docker daemon: not reachable -> start Docker Desktop; enable WSL Integration"
        else
          fail "docker daemon: not reachable -> start Docker (sudo systemctl start docker)"
        fi
        ;;
    esac
    return
  fi
  DOCKER_OK=1
  info="$(printf '%s\n' "$info" | grep -E '^[0-9]+ [0-9]+ ' | tail -1)"
  read -r mem_b ncpu ver <<EOF
$info
EOF
  ok "docker daemon: Docker ${ver:-?} responds"

  comp="$(run_t 20 docker compose version 2>/dev/null | first_line)"
  if [ -n "$comp" ]; then
    ok "docker compose: $comp"
  else
    fail "docker compose: not available -> update Docker Desktop (Compose is included)"
  fi

  check_resources "$mem_b" "$ncpu"
}

# ---- 4. memory and CPUs available to Docker ----
check_resources() {
  local mem_b="$1" ncpu="$2" mib gib_round gib_txt
  case "$mem_b" in
    '' | *[!0-9]*)
      warn "docker memory: could not read it from 'docker info'"
      return
      ;;
  esac
  mib=$((mem_b / 1048576))
  # WSL2 reports about 3-5% less than the configured value (memory=6GB shows ~5.7 GiB),
  # so the 4 and 6 GiB limits are applied to the value rounded to whole GiB.
  gib_round=$(((mib + 512) / 1024))
  gib_txt="$((mib / 1024)).$(((mib % 1024) * 10 / 1024)) GiB"
  if [ "$gib_round" -lt 4 ]; then
    fail "docker memory: $gib_txt -> set memory=6GB (or more) in .wslconfig; wsl --shutdown"
  elif [ "$gib_round" -lt 6 ]; then
    warn "docker memory: $gib_txt -> use --agents 1 and/or raise memory in .wslconfig"
  else
    ok "docker memory: $gib_txt"
  fi
  case "$ncpu" in
    '' | *[!0-9]*) ;;
    *)
      if [ "$ncpu" -lt 2 ]; then
        warn "docker CPUs: $ncpu -> set processors=2 (or more) in .wslconfig"
      else
        ok "docker CPUs: $ncpu"
      fi
      ;;
  esac
}

# ---- 5. free disk ----
check_disk() {
  local gb here fs_home fs_here
  gb="$(sys_free_gb "$HOME")"
  if [ -z "$gb" ]; then
    warn "disk: could not read the free space of ~"
  elif [ "$gb" -lt 10 ]; then
    warn "disk: $gb GB free in ~ -> free space (Kubernetes deletes images when the disk is 85% full)"
  else
    ok "disk: $gb GB free in ~"
  fi
  here="$(sys_pwd)"
  fs_home="$(sys_fs_of "$HOME")"
  fs_here="$(sys_fs_of "$here")"
  if [ -n "$fs_here" ] && [ "$fs_here" != "$fs_home" ]; then
    gb="$(sys_free_gb "$here")"
    if [ -n "$gb" ] && [ "$gb" -lt 10 ]; then
      warn "disk: $gb GB free in the current folder -> free space or use a folder in ~"
    elif [ -n "$gb" ]; then
      ok "disk: $gb GB free in the current folder"
    fi
  fi
  if [ "$IS_WSL" -eq 1 ] && [ -d /mnt/c ]; then
    gb="$(sys_free_gb /mnt/c)"
    if [ -n "$gb" ] && [ "$gb" -lt 10 ]; then
      warn "disk: $gb GB free on C: (Docker's disk image grows there) -> free space on C:"
    elif [ -n "$gb" ]; then
      ok "disk: $gb GB free on C:"
    fi
  fi
}

# ---- 6. kubectl and k3d ----
check_tool() { # name, version command...
  local name="$1" path ver
  shift
  path="$(sys_cmdpath "$name")"
  if [ -z "$path" ]; then
    fail "$name: command not found -> install it inside Ubuntu (section 5 of the environment page)"
    return 1
  fi
  if is_windows_binary "$path"; then
    fail "$name: $path is a Windows program -> install the Linux binary inside Ubuntu"
    return 1
  fi
  ver="$(run_t 20 "$@" 2>/dev/null | first_line)"
  if [ -z "$ver" ]; then
    fail "$name: $path does not print a version -> reinstall it (section 5 of the page)"
    return 1
  fi
  ok "$name: $ver ($path)"
}

check_tools() {
  check_tool kubectl kubectl version --client && HAVE_KUBECTL=1
  check_tool k3d k3d version && HAVE_K3D=1
}

# ---- 7. cluster ----
check_cluster() {
  local ctx want nodes notready rc
  want="k3d-$CLUSTER_NAME"
  if [ "$HAVE_K3D" -ne 1 ] || [ "$DOCKER_OK" -ne 1 ]; then
    warn "cluster: skipped (needs a working docker and k3d)"
    return
  fi
  if ! run_t 30 k3d cluster list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "$CLUSTER_NAME"; then
    ok "no cluster '$CLUSTER_NAME' yet (create it as the lab guide says)"
    return
  fi
  if [ "$HAVE_KUBECTL" -ne 1 ]; then
    warn "cluster '$CLUSTER_NAME': exists, but kubectl is not usable -> fix kubectl first"
    return
  fi
  if ! run_t 20 kubectl config get-contexts -o name 2>/dev/null | grep -qx "$want"; then
    fail "cluster '$CLUSTER_NAME': no kubectl context '$want' -> k3d cluster delete $CLUSTER_NAME; create it again here"
    return
  fi
  ctx="$(run_t 20 kubectl config current-context 2>/dev/null)"
  if [ "$ctx" != "$want" ]; then
    fail "cluster '$CLUSTER_NAME': kubectl context is '${ctx:-none}' -> kubectl config use-context $want"
    return
  fi
  nodes="$(run_t 30 kubectl get nodes --no-headers --request-timeout=15s 2>/dev/null)"
  rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$nodes" ]; then
    fail "cluster '$CLUSTER_NAME': kubectl cannot list nodes -> k3d cluster start $CLUSTER_NAME"
    return
  fi
  notready="$(printf '%s\n' "$nodes" | awk '$2 != "Ready" {printf "%s ", $1}')"
  if [ -n "$notready" ]; then
    warn "cluster '$CLUSTER_NAME': nodes not Ready: ${notready% } -> wait and run 'kubectl get nodes'"
  else
    ok "cluster '$CLUSTER_NAME': context $want, $(printf '%s\n' "$nodes" | wc -l | tr -d ' ') node(s) Ready"
  fi
}

# ---- 8. host port of the cluster ----
port_listening() { # true if something accepts connections on 127.0.0.1:$1
  run_t 3 bash -c "exec 3<>/dev/tcp/127.0.0.1/\$0" "$1" 2>/dev/null
}

check_port() {
  local holders lb="k3d-$CLUSTER_NAME-serverlb" alt="8090"
  [ "$CLUSTER_PORT" = "8090" ] && alt="8091"
  if ! port_listening "$CLUSTER_PORT"; then
    ok "port $CLUSTER_PORT: free"
    return
  fi
  holders=""
  if [ "$DOCKER_OK" -ne 1 ]; then
    warn "port $CLUSTER_PORT: in use; Docker is not reachable, so the owner is unknown"
    return
  fi
  holders="$(run_t 20 docker ps --filter "publish=$CLUSTER_PORT" --format '{{.Names}}' 2>/dev/null)"
  holders="$(printf '%s' "$holders" | tr '\n' ' ')"
  holders="${holders% }"
  if [ "$holders" = "$lb" ]; then
    ok "port $CLUSTER_PORT: used by $lb"
  elif [ -n "$holders" ]; then
    fail "port $CLUSTER_PORT: used by $holders -> stop it, or use -p \"$alt:80@loadbalancer\""
  else
    fail "port $CLUSTER_PORT: used by another process -> free it, or use -p \"$alt:80@loadbalancer\""
  fi
}

# ---- 9. curl and quotes ----
check_curl() {
  local path
  path="$(sys_cmdpath curl)"
  if [ -z "$path" ]; then
    fail "curl: command not found -> sudo apt-get update && sudo apt-get install -y curl"
    return
  fi
  if is_windows_binary "$path"; then
    fail "curl: $path is a Windows program -> sudo apt-get install -y curl"
    return
  fi
  if printf '%s' '{"a":"b"}' | grep -q '"a"'; then
    ok "curl: $path; double quotes in JSON survive in this shell"
  else
    fail "shell: double quotes are being removed -> use the Ubuntu (WSL2) terminal with bash"
  fi
}

# ---- 10. line endings ----
check_crlf() {
  local cr files n shown
  cr="$(printf '\r')"
  files="$(find . -maxdepth 3 \( -name node_modules -o -name .git \) -prune -o \
    -type f \( -name '*.sh' -o -name '*.yaml' -o -name '*.yml' \) -print 2>/dev/null |
    while IFS= read -r f; do
      grep -q "$cr" "$f" 2>/dev/null && printf '%s\n' "$f"
    done)"
  if [ -z "$files" ]; then
    ok "line endings: no CRLF in *.sh / *.yaml files here"
    return
  fi
  n="$(printf '%s\n' "$files" | wc -l | tr -d ' ')"
  shown="$(printf '%s\n' "$files" | sed -n '1,3p' | tr '\n' ' ')"
  warn "line endings: CRLF in $n file(s): ${shown% } -> sed -i 's/\\r\$//' <file>"
}

main() {
  check_shell
  check_folder
  check_docker
  check_disk
  check_tools
  check_cluster
  check_port
  check_curl
  check_crlf
  if [ "$FAILS" -eq 0 ]; then
    echo "RESULT: OK"
    exit 0
  fi
  echo "RESULT: FAIL ($FAILS problem(s))"
  exit 1
}

# runs main only when executed (not when loaded with `source` by the tests)
if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then
  main "$@"
fi
