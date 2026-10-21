#!/usr/bin/env bash
# TopCat Labs — instalação num VPS Ubuntu (22.04 / 24.04), como root.
#   https://DOMINIO/           página inicial (pasta site/)
#   https://DOMINIO/screener/  TopCat Screener (app Node, porta 3000)
#   https://DOMINIO/swap/      TopCat Swap (site estático gerado a partir do GitHub)
#   https://DOMINIO/swap/relay relay dos bundles do Swap (porta 8787)
# HTTPS automático (Caddy + Let's Encrypt).
#
# Instalar:    bash deploy-vps.sh topcatlabs.com
# Atualizar:   bash deploy-vps.sh topcatlabs.com      (o mesmo comando; o Swap vem sempre da versão mais recente do GitHub)
# Estado:      systemctl status topcatscreener topcatswap-relay caddy
# Registos:    journalctl -u topcatscreener -f
set -euo pipefail

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then echo "Uso: bash deploy-vps.sh topcatlabs.com"; exit 1; fi
if [ "$(id -u)" -ne 0 ]; then echo "Corre como root (ou com sudo)."; exit 1; fi

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP=/opt/topcatscreener
PORT=3000
WWW=/var/www/topcatlabs
SWAP_REPO="${SWAP_REPO:-https://github.com/topcatmasterinvestor/topcatswap.git}"
SWAP_SRC=/opt/topcatswap
RELAY_PORT=8787
# Limites por visitante (por hora) e cache de pesquisas iguais (minutos). Muda aqui se quiseres.
RATE_SCANS_HOUR="${RATE_SCANS_HOUR:-12}"
RATE_LOOKUPS_HOUR="${RATE_LOOKUPS_HOUR:-60}"
SCAN_CACHE_MIN="${SCAN_CACHE_MIN:-10}"
# Chave grátis do CoinGecko (plano Demo) para "Outras blockchains": mais rápido. Opcional; fica guardada entre atualizações.
#   COINGECKO_API_KEY=CG-xxxx bash deploy-vps.sh topcatlabs.com
COINGECKO_API_KEY="${COINGECKO_API_KEY:-$( { sed -n 's/^Environment=COINGECKO_API_KEY=//p' /etc/systemd/system/topcatscreener.service 2>/dev/null || true; } | head -1)}"

# Chaves opcionais: ficam em /etc/topcatscreener.env (só o root lê). Sem GRAPH_API_KEY, usa a chave de testes do código.
# Para usar outra:  GRAPH_API_KEY=a_tua_chave bash deploy-vps.sh topcatlabs.com   (depois fica guardada)
ENV_FILE=/etc/topcatscreener.env
envget() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | head -1 || true; }   # sem o ficheiro (1.ª vez) devolve vazio
GRAPH_API_KEY="${GRAPH_API_KEY:-$(envget GRAPH_API_KEY)}"
COINGECKO_API_KEY="${COINGECKO_API_KEY:-$(envget COINGECKO_API_KEY)}"
# Password do site (opcional, protege /, /screener e /swap):  SITE_PASSWORD='…' bash deploy-vps.sh topcatlabs.com
# Só fica guardada a versão cifrada (bcrypt). Para desligar: SITE_PASSWORD=off bash deploy-vps.sh topcatlabs.com
SITE_USER="${SITE_USER:-$(envget SITE_USER)}"; SITE_USER="${SITE_USER:-topcat}"
SITE_PASS_HASH="$(envget SITE_PASS_HASH)"
save_env() {
  umask 077
  printf 'GRAPH_API_KEY=%s\nCOINGECKO_API_KEY=%s\nSITE_USER=%s\nSITE_PASS_HASH=%s\n' "$GRAPH_API_KEY" "$COINGECKO_API_KEY" "$SITE_USER" "$SITE_PASS_HASH" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"; umask 022
}
save_env

echo "==> Pacotes do sistema"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg ufw git debian-keyring debian-archive-keyring apt-transport-https >/dev/null

echo "==> Node.js 22"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node --version

echo "==> Caddy (servidor web com HTTPS automático)"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

echo "==> Utilizador e ficheiros da app em $APP"
id topcat >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin topcat
mkdir -p "$APP"
# copia a app (mantém um config.json que já lá esteja)
cp -r "$SRC/server.js" "$SRC/package.json" "$SRC/public" "$APP/"
[ -f "$SRC/README.md" ] && cp "$SRC/README.md" "$APP/"
chown -R topcat:topcat "$APP"

echo "==> Página inicial em $WWW"
mkdir -p "$WWW"
cp -r "$SRC/site/." "$WWW/"

# Repositório privado: chave de leitura (deploy key) em $SWAP_KEY → clone por SSH
SWAP_KEY=/root/.ssh/topcatswap_deploy
if [ -f "$SWAP_KEY" ]; then
  export GIT_SSH_COMMAND="ssh -i $SWAP_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
  SWAP_REPO="${SWAP_REPO_SSH:-git@github.com:TOPCATMASTERINVESTOR/topcatswap.git}"
fi
echo "==> TopCat Swap a partir de $SWAP_REPO"
if [ -d "$SWAP_SRC/.git" ]; then
  git -C "$SWAP_SRC" remote set-url origin "$SWAP_REPO"
  if git -C "$SWAP_SRC" fetch -q --depth 1 origin; then
    git -C "$SWAP_SRC" reset -q --hard FETCH_HEAD
  else
    echo "!! Não consegui ir buscar o Swap ao GitHub (repositório privado sem chave em $SWAP_KEY?). Fica a versão já instalada."
  fi
else
  rm -rf "$SWAP_SRC"
  git clone -q --depth 1 "$SWAP_REPO" "$SWAP_SRC" || { echo "!! Não consegui clonar o Swap. Se o repositório é privado, cria a chave em $SWAP_KEY (ver README)."; exit 1; }
fi
# relay dos bundles deste servidor como predefinição (antes do build, por causa dos hashes de integridade)
sed -i "s#defaultRelay: \"[^\"]*\"#defaultRelay: \"https://$DOMAIN/swap/relay\"#" "$SWAP_SRC/web-src/config.js"
(cd "$SWAP_SRC" && node tools/build-web.js >/dev/null)
rm -rf "$WWW/swap.new" && cp -r "$SWAP_SRC/dist-web" "$WWW/swap.new"
rm -rf "$WWW/swap" && mv "$WWW/swap.new" "$WWW/swap"
echo "    versão: $(cat "$SWAP_SRC/web-src/VERSION")"
chmod -R a+rX "$WWW" "$SWAP_SRC"

echo "==> Serviço systemd"
cat > /etc/systemd/system/topcatscreener.service <<EOF
[Unit]
Description=TopCat Screener
After=network-online.target
Wants=network-online.target

[Service]
User=topcat
WorkingDirectory=$APP
Environment=PORT=$PORT
Environment=BASE_PATH=/screener
Environment=TRUST_PROXY=1
Environment=RATE_SCANS_HOUR=$RATE_SCANS_HOUR
Environment=RATE_LOOKUPS_HOUR=$RATE_LOOKUPS_HOUR
Environment=SCAN_CACHE_MIN=$SCAN_CACHE_MIN
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v node) $APP/server.js
Restart=always
RestartSec=3
# endurecimento básico
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$APP
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/topcatswap-relay.service <<EOF
[Unit]
Description=TopCat Swap bundle relay
After=network-online.target
Wants=network-online.target

[Service]
User=topcat
WorkingDirectory=$SWAP_SRC
Environment=PORT=$RELAY_PORT
Environment=HOST=127.0.0.1
Environment=ALLOWED_ORIGINS=https://$DOMAIN,https://www.$DOMAIN
ExecStart=$(command -v node) $SWAP_SRC/relay/server.mjs
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

if [ -n "${SITE_PASSWORD:-}" ]; then
  if [ "$SITE_PASSWORD" = "off" ]; then SITE_PASS_HASH=""; else SITE_PASS_HASH="$(caddy hash-password --plaintext "$SITE_PASSWORD")"; fi
  save_env
fi
AUTH=""
if [ -n "$SITE_PASS_HASH" ]; then
  # o relay do Swap fica de fora (só aceita pedidos do próprio site)
  AUTH="	@locked not path /swap/relay*
	basicauth @locked {
		$SITE_USER $SITE_PASS_HASH
	}"
  echo "==> Site protegido por password (utilizador: $SITE_USER)"
else
  echo "==> Site aberto ao público (sem password)"
fi

echo "==> Caddy: https://$DOMAIN  (e www.$DOMAIN)"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN, www.$DOMAIN {
	encode gzip zstd
$AUTH
	handle /screener* {
		reverse_proxy 127.0.0.1:$PORT
	}
	handle /swap/relay* {
		reverse_proxy 127.0.0.1:$RELAY_PORT
	}
	@swapbare path /swap
	redir @swapbare /swap/ 301
	handle {
		root * $WWW
		file_server
	}
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
		-Server
	}
}
EOF

echo "==> Firewall (SSH, HTTP, HTTPS)"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

systemctl daemon-reload
systemctl enable topcatscreener topcatswap-relay caddy >/dev/null 2>&1
systemctl restart topcatscreener topcatswap-relay
systemctl reload caddy 2>/dev/null || systemctl restart caddy

sleep 2
if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/screener/api/config"; then echo "==> App a responder localmente: OK"; else echo "!! A app não respondeu. Vê: journalctl -u topcatscreener -n 50"; fi
if curl -fsS -o /dev/null -H "Origin: https://$DOMAIN" "http://127.0.0.1:$RELAY_PORT/"; then echo "==> Relay do Swap a responder: OK"; else echo "!! O relay não respondeu. Vê: journalctl -u topcatswap-relay -n 50"; fi

IP="$(curl -fsS -4 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
cat <<EOF

Pronto.
  Início:       https://$DOMAIN
  Screener:     https://$DOMAIN/screener
  Swap:         https://$DOMAIN/swap
  IP do VPS:    $IP   (os registos DNS A de $DOMAIN e www têm de apontar para aqui)
  Limites:      $RATE_SCANS_HOUR pesquisas e $RATE_LOOKUPS_HOUR consultas por visitante/hora · cache $SCAN_CACHE_MIN min

O certificado HTTPS é emitido automaticamente no primeiro acesso, assim que o DNS apontar para este IP.
Se o site não abrir em HTTPS, vê:  journalctl -u caddy -n 50
EOF
