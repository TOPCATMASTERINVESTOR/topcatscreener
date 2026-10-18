#!/usr/bin/env bash
# TopCat Screener — acesso externo via Cloudflare Tunnel.
# Põe a app e o túnel a correr como serviços (arrancam sozinhos com o Ubuntu)
# e mostra o endereço público https://….trycloudflare.com
#
# Uso:   bash acesso-externo.sh            instala / atualiza
#        bash acesso-externo.sh endereco   mostra o endereço atual
#        bash acesso-externo.sh parar      desliga o acesso externo
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-3000}"
RUN_USER="${SUDO_USER:-$USER}"

endereco() {
  local url=""
  for _ in $(seq 1 30); do
    url="$(sudo journalctl -u topcatscanner-tunnel --no-pager -o cat 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)"
    [ -n "$url" ] && break
    sleep 1
  done
  if [ -n "$url" ]; then echo "$url"; else echo "Ainda sem endereço. Vê o registo com: sudo journalctl -u topcatscanner-tunnel -f" >&2; return 1; fi
}

case "${1:-}" in
  endereco) endereco; exit $? ;;
  parar)
    sudo systemctl disable --now topcatscanner-tunnel 2>/dev/null || true
    echo "Acesso externo desligado. A app continua em http://localhost:$PORT"
    exit 0 ;;
esac

NODE_BIN="$(command -v node || true)"
[ -z "$NODE_BIN" ] && { echo "Node.js não encontrado. Instala-o primeiro."; exit 1; }

# 1) Palavra-passe (guardada em config.json; quem abrir o link tem de a escrever)
CONFIG="$APP_DIR/config.json"
CURRENT_PASS=""
[ -f "$CONFIG" ] && CURRENT_PASS="$(node -e "try{console.log(require('$CONFIG').ACCESS_PASSWORD||'')}catch(e){}")"
if [ -n "$CURRENT_PASS" ]; then
  read -r -p "Já há uma palavra-passe definida. Mudar? [s/N] " ans
  [[ "$ans" =~ ^[sS] ]] && CURRENT_PASS=""
fi
while [ -z "$CURRENT_PASS" ]; do
  read -r -s -p "Palavra-passe para quem aceder de fora: " p1; echo
  read -r -s -p "Repete: " p2; echo
  if [ -n "$p1" ] && [ "$p1" = "$p2" ]; then CURRENT_PASS="$p1"; else echo "Não coincidem ou está vazia, tenta outra vez."; fi
done
PASS="$CURRENT_PASS" CFG="$CONFIG" node -e "
const fs=require('fs'); let c={}; try{c=JSON.parse(fs.readFileSync(process.env.CFG,'utf8'))}catch(e){}
c.ACCESS_PASSWORD=process.env.PASS; fs.writeFileSync(process.env.CFG, JSON.stringify(c,null,2)+'\n');"
chmod 600 "$CONFIG"

# 2) cloudflared
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "A instalar o cloudflared…"
  ARCH="$(dpkg --print-architecture)"
  TMP="$(mktemp -d)"
  curl -fsSL -o "$TMP/cloudflared.deb" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}.deb"
  sudo apt install -y "$TMP/cloudflared.deb"
  rm -rf "$TMP"
fi

# 3) Serviço da app
sudo tee /etc/systemd/system/topcatscanner.service >/dev/null <<EOF
[Unit]
Description=TopCat Screener
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_USER
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT
ExecStart=$NODE_BIN $APP_DIR/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# 4) Serviço do túnel (quick tunnel: endereço grátis, muda quando o túnel reinicia)
CF_BIN="$(command -v cloudflared)"
sudo tee /etc/systemd/system/topcatscanner-tunnel.service >/dev/null <<EOF
[Unit]
Description=TopCat Screener - Cloudflare Tunnel
After=topcatscanner.service network-online.target
Wants=network-online.target
Requires=topcatscanner.service

[Service]
User=$RUN_USER
ExecStart=$CF_BIN tunnel --no-autoupdate --url http://localhost:$PORT
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Versão antiga (ATH Scanner): desliga e remove os serviços com o nome antigo.
for old in athscanner-tunnel athscanner; do
  if systemctl list-unit-files "$old.service" >/dev/null 2>&1 && [ -f "/etc/systemd/system/$old.service" ]; then
    sudo systemctl disable --now "$old" 2>/dev/null || true
    sudo rm -f "/etc/systemd/system/$old.service"
  fi
done

# Se a app estiver a correr à mão num terminal, liberta a porta.
sudo systemctl stop topcatscanner-tunnel topcatscanner 2>/dev/null || true
fuser -k "${PORT}/tcp" 2>/dev/null || true
sleep 1

sudo systemctl daemon-reload
sudo systemctl enable topcatscanner topcatscanner-tunnel >/dev/null 2>&1
sudo systemctl restart topcatscanner
sleep 1
sudo systemctl restart topcatscanner-tunnel

echo
echo "A app está a correr em http://localhost:$PORT"
echo "A obter o endereço público…"
URL="$(endereco)" && {
  echo
  echo "  Endereço público:  $URL"
  echo "  Palavra-passe:     a que acabaste de definir (o nome de utilizador pode ser qualquer um)"
  echo
  echo "O endereço muda se o túnel ou o computador reiniciarem."
  echo "Para o voltar a ver:  bash $APP_DIR/acesso-externo.sh endereco"
}
