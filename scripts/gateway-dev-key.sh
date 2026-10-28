#!/usr/bin/env bash
# Mints a 24-hour Astropods AI Gateway development key and writes it into .env.
# Needs: `ast login` done once, Docker running, and the dev harness project
# (default ~/projects/astropods-gateway-dev, override with ASTRO_DEV_PROJECT).
# The key is never printed.
set -euo pipefail

AST="${AST:-$HOME/.ast/bin/ast}"
DEV_PROJECT="${ASTRO_DEV_PROJECT:-$HOME/projects/astropods-gateway-dev}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO/.env"

(cd "$DEV_PROJECT" && "$AST" project stop --non-interactive >/dev/null 2>&1 || true)
(cd "$DEV_PROJECT" && "$AST" project start --background --non-interactive >/dev/null)

container="$(docker ps --format '{{.Names}}' | grep -E -- '-agent-1$' | while read -r c; do
  docker exec "$c" printenv ASTRO_GATEWAY_API_KEY >/dev/null 2>&1 && echo "$c" && break
done)"
[ -n "$container" ] || { echo "No running Astropods agent container with a gateway key found." >&2; exit 1; }

url="$(docker exec "$container" printenv ASTRO_GATEWAY_URL)"
key="$(docker exec "$container" printenv ASTRO_GATEWAY_API_KEY)"

[ -f "$ENV_FILE" ] || cp "$REPO/.env.example" "$ENV_FILE"
tmp="$(mktemp)"
grep -v -E '^(ASTRO_GATEWAY_URL|ASTRO_GATEWAY_API_KEY)=' "$ENV_FILE" > "$tmp" || true
printf 'ASTRO_GATEWAY_URL=%s\nASTRO_GATEWAY_API_KEY=%s\n' "$url" "$key" >> "$tmp"
mv "$tmp" "$ENV_FILE"
chmod 600 "$ENV_FILE"

# The key stays valid after the harness stops, so do not leave its containers running.
(cd "$DEV_PROJECT" && "$AST" project stop --non-interactive >/dev/null 2>&1 || true)

echo "Gateway dev key written to .env (valid about 24 hours). Restart 'npm run dev' to pick it up."
