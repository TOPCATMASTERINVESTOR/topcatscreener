# TopCat Screener

Procura tokens numa ou em várias blockchains ao mesmo tempo (botão **Todas**), por FDV, volume médio diário, idade e data do último ATH, e ordena-os por distância ao ATH ou pela data do ATH.

## Procurar um token

No painel **Procurar um token**, cola o endereço do contrato (CA). Escolhe a blockchain ou deixa **Detetar blockchain**: com um endereço 0x procura em todas as EVM, e com outro formato procura em Solana. A lista passa a mostrar só esse token, com preço, variações, FDV, volume 24h, data de lançamento e ATH.

## Risco de scam (coluna 2)

Para cada token, a coluna **Risk** mostra o alerta mais grave e a sua categoria. A lista completa aparece ao passar o rato por cima e vai também para o CSV.

| Categoria | Exemplos | Gravidade |
|---|---|---|
| Honeypot | não se consegue vender, compra bloqueada, tokens congeláveis (Solana) | crítica |
| Ruggable | o dono pode mudar saldos, mintar, pausar, usar blacklist; dono escondido; LP desbloqueada; contrato atualizável | crítica/alta |
| Tax trap | impostos de venda/compra altos ou alteráveis | crítica/alta |
| Whale-heavy | top 10 ou criador com grande parte do supply | alta/média |
| Red flag | criador com honeypots anteriores, contrato não verificado | média |
| Market risk | liquidez muito baixa face à FDV, volume muitas vezes maior que a liquidez, token com menos de 2 dias | média/baixa |

Os dados vêm da GoPlus Security, que é gratuita e não precisa de chave, mais heurísticas da própria app. "Not checked" significa que a GoPlus não tem dados para esse token (Robinhood Chain e Arc só têm as heurísticas). Ausência de alertas não é garantia de segurança.

## Ordenação

Qualquer coluna pode ordenar os resultados: clica no cabeçalho (outro clique inverte a direção) ou usa o menu **Sort** e o botão de direção ao lado. A predefinição é **mais perto do ATH**. A escolha é enviada na pesquisa: quando há mais candidatos do que o limite, o servidor fica com os melhores segundo essa coluna sempre que existe um valor aproximado antes da análise completa (FDV, liquidez, preço, volume); nas outras colunas a pré-seleção continua a ser pelo volume.

## Alertas de risco

A 2.ª coluna mostra alertas de scam por ordem de gravidade: **Honeypot** (não dá para vender, imposto de venda ≥ 50%), **Ruggable** (dono pode mexer em saldos, mint ativo, LP sem bloqueio, dono oculto, pausa, blacklist, contrato atualizável), **Tax trap** (impostos ≥ 10% ou alteráveis), **Whale-heavy** (carteiras de topo ou do criador com muito supply) e **Market risk** (liquidez muito fina face à FDV, volume suspeito face à liquidez, token muito novo).
Os dados de contrato vêm da API pública GoPlus Security (Ethereum, BSC, Base, Arbitrum, Polygon, Optimism e Solana); as regras de mercado são calculadas pela app e funcionam em todas as chains. Passa o rato por cima do selo para ver a lista completa. Não é aconselhamento financeiro.

## Exclusões

Nos filtros podes excluir stablecoins, ações e fundos tokenizados (xStocks, Ondo, Backed, BUIDL, ouro tokenizado…), moedas nativas e embrulhadas, ou qualquer combinação.

## Idiomas

A app abre em inglês. O seletor no topo muda para espanhol, russo, chinês ou português, e a escolha fica guardada no browser. As mensagens do servidor (progresso, avisos, erros) seguem o idioma escolhido. As traduções estão em `public/i18n.js` (interface) e no início de `server.js` (`SMSG`).

## Pools Uniswap

Nas **Definições** escolhes que versões de pools entram na pesquisa: V2, V3, V4, duas delas ou todas (pelo menos uma). A escolha vale para preço, volume, ATH e liquidez. BSC, Arbitrum, Polygon e Optimism não têm pools V2 indexadas. Algumas pools V4 com hooks reportam volume inflacionado.

## Colunas e Definições

No separador **Definições** escolhes que colunas aparecem. As colunas desligadas não são calculadas, e a pesquisa fica mais rápida.

- **Variação de preço:** 1h, 6h, 12h, 24h, 3 dias, 1 semana, 2 semanas, 1 mês, 3 meses, 6 meses e 1 ano. As de 1h, 6h e 12h usam dados hora a hora (Uniswap V3, ou GeckoTerminal em Solana, Robinhood Chain e Arc). As restantes usam o fecho diário.
- **Gráficos:** mini-gráficos de 1 semana (de hora a hora, quando há dados), 1 mês, 3 meses e 1 ano. Ficam verdes quando o preço subiu no período e laranja quando desceu.

## Arrancar

Precisa só do Node.js 18+ (o mesmo do TopCatSwap). Sem `npm install`.

```bash
cd topcatscanner
node server.js
```

Abre http://localhost:3000.

O código inclui uma chave de testes da The Graph, para qualquer pessoa poder experimentar sem configurar nada. Para usar a tua: variável `GRAPH_API_KEY`, um `config.json` com `{ "GRAPH_API_KEY": "..." }` (ignorado pelo git), ou o campo **Chave da The Graph** na interface. No VPS: `GRAPH_API_KEY=a_tua_chave bash deploy-vps.sh topcatlabs.com` (fica guardada em `/etc/topcatscreener.env`).

## De onde vêm os dados

| Chain | Fonte |
|---|---|
| Ethereum, Base | The Graph — Uniswap V3 + Uniswap V2 (somados); V4 só para a liquidez |
| BSC, Arbitrum, Polygon, Optimism | The Graph — Uniswap V3; V4 só para a liquidez |
| Solana | GeckoTerminal (API pública, sem chave; a The Graph não tem um subgraph DEX fiável para Solana) |
| Robinhood Chain, Arc | GeckoTerminal (ainda sem subgraph DEX na The Graph; o id de rede é descoberto automaticamente) |

## Como cada número é calculado

- **FDV** = supply total × preço atual.
- **Volume médio** = soma do volume dos últimos 7 dias ÷ 7, ou ÷ (dias desde a criação + 1) se o token for mais novo.
- **Dias desde a criação** = primeiro dia com trading nas DEX indexadas (em Solana, a criação da pool).
- **ATH** = maior máximo diário. Para evitar picos falsos de pools sem liquidez, um máximo só conta em dias com ≥ $1.000 de volume e nunca acima de 5× o fecho desse dia; se o preço atual for o maior, o ATH é hoje.
- **% do ATH** = preço atual ÷ ATH.
- **Liquidez V3+V4** = 2 × (tokens bloqueados nas pools Uniswap V3 e V4 × preço atual). Conta os dois lados das pools e usa o preço calculado pela app, não o valor em USD do subgraph, que nas pools V4 com hooks pode vir inflacionado. Em Solana, Robinhood Chain e Arc é a soma das reservas das pools no GeckoTerminal (todas as DEX).

## Limites

- Só aparecem tokens com trading nos últimos 7 dias.
- Em EVM, analisa até 600 candidatos por chain (os de maior volume), com todas as chains EVM em paralelo.
- No GeckoTerminal (Solana, Robinhood Chain, Arc) o limite é de 30 pedidos/min partilhados: até 45 tokens se só uma destas estiver escolhida, 20 por chain se forem várias. Com as três, a pesquisa demora uns 3–4 minutos.
- O supply vem do subgraph e é lido na criação do token; tokens com mint posterior podem ter FDV subestimada.
- Volumes da V2 incluem wash trading de alguns tokens.

## Acesso externo

```bash
bash acesso-externo.sh
```

O script pede uma palavra-passe e instala o `cloudflared`. Depois põe a app e o túnel Cloudflare a correr como serviços, que arrancam sozinhos com o Ubuntu, e mostra o endereço público `https://….trycloudflare.com`. Não é preciso abrir portas no router.

- `bash acesso-externo.sh endereco` mostra o endereço atual (muda quando o túnel reinicia).
- `bash acesso-externo.sh parar` desliga o acesso externo.
- No máximo 2 pesquisas correm em simultâneo, para proteger a quota da The Graph.

## Publicar num VPS (topcatlabs.com/screener)

1. **Domínio:** na Cloudflare, em *Domain Registration → Register Domains*, compra `topcatlabs.com`.
2. **Servidor:** cria um VPS com Ubuntu 24.04 (o plano mais pequeno chega). Guarda o endereço IPv4.
3. **DNS:** na Cloudflare, em `topcatlabs.com` → *DNS → Records*, cria dois registos **A**: `@` e `www`, ambos com o IP do VPS e com o proxy em **DNS only** (nuvem cinzenta).
4. **Instalar**, a partir do teu Ubuntu:
   ```bash
   scp topcatscanner.zip root@IP_DO_VPS:/root/
   ssh root@IP_DO_VPS
   apt install -y unzip && unzip -o topcatscanner.zip && bash topcatscanner/deploy-vps.sh topcatlabs.com
   ```
5. Abre `https://topcatlabs.com/screener`. O certificado HTTPS é criado automaticamente no primeiro acesso.

**Atualizar:** copia o zip novo, descompacta-o e volta a correr `bash topcatscanner/deploy-vps.sh topcatlabs.com`.

**Limites do site público:** 12 pesquisas e 60 consultas por visitante e por hora, e cache de 10 minutos para pesquisas iguais. Para mudar, corre por exemplo `RATE_SCANS_HOUR=20 bash topcatscanner/deploy-vps.sh topcatlabs.com`.

## topcatlabs.com — página inicial e TopCat Swap

O `deploy-vps.sh` publica tudo no mesmo domínio:

| Endereço | O quê |
|---|---|
| `/` | Página inicial (pasta `site/`), com seletor de idioma EN/ES/RU/ZH/PT |
| `/screener/` | TopCat Screener |
| `/swap/` | TopCat Swap, gerado a partir de github.com/topcatmasterinvestor/topcatswap |
| `/swap/relay` | Relay dos bundles do Swap (só aceita pedidos de topcatlabs.com) |

Cada vez que corres o script, o Swap é atualizado para a versão mais recente do GitHub.

**Password para o site inteiro** (/, /screener e /swap; o relay fica de fora): `SITE_PASSWORD='…' bash deploy-vps.sh topcatlabs.com`. O utilizador é `topcat` (muda com `SITE_USER=…`). Só a versão cifrada fica guardada em `/etc/topcatscreener.env` e mantém-se nos deploys seguintes. Para tirar: `SITE_PASSWORD=off bash deploy-vps.sh topcatlabs.com`.

**Repositório do Swap privado:** o VPS precisa de uma chave só de leitura (deploy key). Uma vez, no VPS:

```
ssh-keygen -t ed25519 -N "" -C topcatlabs-vps -f /root/.ssh/topcatswap_deploy && cat /root/.ssh/topcatswap_deploy.pub
```

e junta a chave pública em github.com/TOPCATMASTERINVESTOR/topcatswap → Settings → Deploy keys → Add deploy key (sem "Allow write access"). O script passa a usá-la sozinho.

## GitHub Pages (sem servidor)

O Screener também corre como site estático: **https://topcatmasterinvestor.github.io/topcatscreener/**

- `node tools/build-web.js` cria `dist-web/`: o mesmo `server.js` corre dentro do navegador e as pesquisas vão diretamente do computador de cada visitante para a The Graph, o GeckoTerminal, o GoPlus e o CoinGecko (os limites por minuto passam a ser de cada visitante).
- O workflow `.github/workflows/pages.yml` publica-o a cada `git push`. Ativa em **Settings › Pages › Source: GitHub Actions**.
- Usa a chave de testes incluída no código. Para outra, cria o secret **GRAPH_API_KEY** (Settings › Secrets and variables › Actions); o workflow usa-a no lugar da de testes.
- Para experimentar no teu computador: `node tools/build-web.js && python3 -m http.server 8080 -d dist-web` → http://localhost:8080

## Análise de tendência

Depois de uma pesquisa, o botão **Análise de tendência** abre uma tab nova com a lista atual (os resultados trazem até 3 anos de fechos diários).
- **Tipo 1** — ATH → queda até ao ATL → recuperação: sliders L (ATH→hoje), L1 (ATH→ATL), L2 (ATL→hoje) e d.
- **Tipo 2** — subida a partir do ATL: sliders L (ATL→hoje) e d.
- Um intervalo **d** vai de um máximo local (fecho diário) ao primeiro fecho acima desse máximo; os intervalos seguem-se a partir do ATL. A lista é ordenada pelo número de intervalos d dentro do intervalo escolhido (lógica em `public/trendcore.js`).

