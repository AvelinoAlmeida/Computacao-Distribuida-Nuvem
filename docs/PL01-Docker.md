# Runbook PL01: Docker

Ambiente: Windows 11 + WSL2 (Ubuntu) + Docker Desktop (Docker 29.8.2, Compose v5.5.1).
Pasta de trabalho: `pl01/` deste repositório, que no WSL é `/mnt/c/Users/Avelino/Documents/GitHub/Computacao-Distribuida-Nuvem/pl01`. A ficha usa `~/pl01`.
Todos os comandos correm no terminal Ubuntu, a partir dessa pasta:

```bash
cd /mnt/c/Users/Avelino/Documents/GitHub/Computacao-Distribuida-Nuvem/pl01
```

Baseado no `pl01/README.md` e no código da pasta `pl01/`. O enunciado `MEI.CDN-2627-PL01.md` não está no repositório.

## Estrutura de pastas

```text
Computacao-Distribuida-Nuvem/
├── docs/
│   └── PL01-Docker.md            ← este runbook
└── pl01/                         ← pasta de trabalho
    ├── .dockerignore
    ├── Dockerfile
    ├── README.md
    ├── app.js
    ├── compose.healthcheck.yaml
    ├── compose.yaml
    ├── package-lock.json
    └── package.json
```

| Ficheiro | Para quê |
|---|---|
| `app.js`, `package.json` | App Express com `GET /`, `GET /health` e `GET /db` (este último corre `SELECT now()` no Postgres) |
| `Dockerfile`, `.dockerignore` | Imagem da app (`node:22-alpine`, `npm ci --omit=dev`) |
| `compose.yaml` | App + Postgres com `depends_on` sem condição (primeira tentativa) |
| `compose.healthcheck.yaml` | O mesmo, com `healthcheck` no Postgres e `condition: service_healthy` (a correção) |

---

## 0. Preparação

```bash
docker version                          # tem de mostrar Client e Server (29.8.2)
docker compose version                  # Compose v5.5.1
docker ps                               # confirma que nada usa a porta 3000
docker pull node:22-alpine              # imagem base
docker pull postgres:17-alpine          # base de dados
```

Não é preciso ter `node` instalado no WSL: a app corre sempre dentro de um contentor. Para a correr sem Docker, com Node no sistema: `npm ci && node app.js`.

Os ficheiros vêm do checkout Windows com fins de linha CRLF (`file Dockerfile compose.yaml app.js`). O Docker e o Compose aceitam-nos sem problemas.

---

## 1. Imagem e contentor

```bash
docker build -t cdn-pl01-app:1.0 .           # constrói a imagem a partir do Dockerfile (~6 s, com a base em cache)
docker images cdn-pl01-app                   # 62.9 MB de conteúdo (251 MB em disco)
docker run -d --name app -p 3000:3000 cdn-pl01-app:1.0   # liga a porta 3000 do portátil à 3000 do contentor
curl -s localhost:3000/; echo           # "Hello from PL01!"; hostname = id curto do contentor
curl -s localhost:3000/health; echo     # {"status":"ok",...}
curl -s localhost:3000/db; echo         # erro 500: DATABASE_URL is not set (não há base de dados)
docker logs app                         # "PL01 app listening on port 3000"
docker exec app hostname                # o mesmo id que aparece no JSON
docker stop app && docker rm app
```

---

## 2. Compose: app + Postgres (primeira tentativa)

```bash
docker compose up -d --build
for i in $(seq 1 12); do curl -s -w ' %{http_code}\n' localhost:3000/db; sleep 0.5; done   # logo a seguir ao up
docker compose ps
docker compose logs db | grep "ready to accept"
docker compose logs app
docker volume ls | grep pl01            # pl01_dbdata
docker network ls | grep pl01           # pl01_default
docker compose exec -T app getent hosts db   # o nome do serviço resolve para o IP do Postgres (172.18.0.2)
```

O nome do projeto Compose vem do nome da pasta (`pl01`). Por isso os recursos chamam-se `pl01-app-1`, `pl01_dbdata` e `pl01_default`, tal como em `~/pl01`.

`depends_on: [db]` só espera que o contentor do Postgres **arranque**, não que aceite ligações. Os primeiros pedidos a `/db` falham com `ECONNREFUSED` até o Postgres terminar a inicialização. Na primeira vez, o Postgres cria a base de dados e reinicia uma vez.

Réplicas com porta fixa:

```bash
docker compose up -d --scale app=2      # falha: Bind for 0.0.0.0:3000 failed: port is already allocated
docker compose down
```

---

## 3. Compose com healthcheck (a correção)

```bash
docker compose -f compose.healthcheck.yaml up -d --build   # db: Waiting -> Healthy, só depois app: Started
docker compose -f compose.healthcheck.yaml ps              # db aparece como "(healthy)"
curl -s localhost:3000/db; echo                            # {"status":"ok",...} logo no primeiro pedido
```

O `healthcheck` corre `pg_isready` de 5 em 5 s. `condition: service_healthy` adia o arranque da app até ao primeiro sucesso.

---

## 4. Persistência com volume

```bash
docker compose -f compose.healthcheck.yaml exec -T db psql -U app -d app \
  -c "CREATE TABLE notas (id serial PRIMARY KEY, texto text); INSERT INTO notas (texto) VALUES ('sobrevive ao down');"
docker compose -f compose.healthcheck.yaml down        # remove os contentores e a rede, mantém o volume
docker volume ls | grep pl01                           # pl01_dbdata continua lá
docker compose -f compose.healthcheck.yaml up -d
docker compose -f compose.healthcheck.yaml exec -T db psql -U app -d app -c "SELECT * FROM notas;"   # a linha continua lá
```

---

## 5. Limpeza

```bash
docker compose -f compose.healthcheck.yaml down -v     # -v também apaga o volume pl01_dbdata
docker rmi cdn-pl01-app:1.0 pl01-app                        # a imagem do passo 1 e a que o Compose construiu
docker ps -a | grep pl01                               # vazio
docker volume ls | grep pl01                           # vazio
docker images | grep -E "cdn-pl01-app|pl01"                 # vazio
```

---

## Resultados obtidos (8 de outubro de 2026, execução a partir de `pl01/` do repositório)

| Secção | Medição | Resultado |
|---|---|---|
| 0 | Versões | Docker 29.8.2 (Client e Server), Compose v5.5.1; porta 3000 livre |
| 1 | Build | ~6 s; `cdn-pl01-app:1.0` com 62.9 MB de conteúdo (251 MB em disco) |
| 1 | `/` e `/health` | `200`; `hostname` = id do contentor (`58441f3e60b6`), o mesmo que dá `docker exec app hostname` |
| 1 | `/db` sem Compose | `500`, `DATABASE_URL is not set` |
| 2 | `/db` de 0,5 em 0,5 s logo depois do `up` | 1 × `000` (0,0 s), 2 × `500 ECONNREFUSED 172.18.0.2:5432` (0,5 e 1,1 s), depois `200` a partir de 1,6 s |
| 2 | Logs do Postgres | `ready to accept connections` → `fast shutdown` → `shut down` → `ready` (reinício no fim da inicialização, em ~0,4 s) |
| 2 | Recursos | volume `pl01_dbdata`, rede `pl01_default`, `db` → `172.18.0.2` |
| 2 | `--scale app=2` | `pl01-app-2` é criado mas não arranca: `Bind for 0.0.0.0:3000 failed: port is already allocated` |
| 3 | `up` com healthcheck | `db` `Waiting` → `Healthy`, depois a app arranca; `up` demora 7,8 s; o primeiro `/db` já dá `200` |
| 4 | `down` + `up` sem `-v` | `pl01_dbdata` mantém-se; `SELECT` devolve `1 \| sobrevive ao down` |
| 5 | Depois da limpeza | `Volume pl01_dbdata Removed`; 2 imagens apagadas; sem contentores, volumes nem imagens da PL01 |

---

## Problemas encontrados

| Sintoma | Causa | Solução |
|---|---|---|
| `/db` dá `ECONNREFUSED` logo depois de `docker compose up` | `depends_on` sem condição não espera que o Postgres esteja pronto | Usar `compose.healthcheck.yaml` (healthcheck + `service_healthy`); em produção, pôr retries na app |
| Os comandos seguintes de um bloco colado não correm depois de `docker compose exec` | O `exec` lê o resto do stdin | Usar `exec -T` ou correr o `exec` sozinho |
| `--scale app=2` falha com `port is already allocated` | Duas réplicas não podem publicar a mesma porta do portátil | Tirar o `ports` fixo e pôr um proxy (nginx) à frente; na PL02, Deployment + Service |
| Ficheiros com CRLF quando se corre a partir de `/mnt/c` | O checkout Windows do Git converte os fins de linha | Não é preciso fazer nada: o Dockerfile, o YAML e o JS funcionam com CRLF. Para scripts `.sh` seria preciso LF (`.gitattributes` ou `dos2unix`) |
| Comandos `wsl ... bash /mnt/c/...` lançados a partir do Git Bash não encontram o ficheiro | O Git Bash converte `/mnt/c/...` num caminho Windows (`C:/Program Files/Git/mnt/...`) | Correr diretamente no terminal Ubuntu, ou prefixar com `MSYS_NO_PATHCONV=1` |

---

## Resumo da execução

| Ponto | O que foi feito | Resultado |
|---|---|---|
| 0. Preparação | Verificar o Docker e o Compose, confirmar a porta 3000 livre, descarregar `node:22-alpine` e `postgres:17-alpine` | ✅ Ambiente pronto |
| 1. Imagem e contentor | `docker build` + `docker run` da app sozinha; testar `/`, `/health` e `/db` | ✅ `/` e `/health` dão `200`; `/db` dá `500` (esperado, não há base de dados) |
| 2. Compose sem condição | `compose up` de app + Postgres; 12 pedidos a `/db`; inspecionar volume, rede e DNS; tentar `--scale app=2` | ✅ Corrida reproduzida: `ECONNREFUSED` até 1,6 s; o scale falha pela porta fixa |
| 3. Compose com healthcheck | `up` com `compose.healthcheck.yaml` | ✅ A app só arranca com o `db` `Healthy`; o primeiro `/db` dá `200` |
| 4. Persistência | Criar a tabela `notas`, fazer `down` sem `-v` e `up`, ler a tabela | ✅ Os dados sobrevivem no volume `pl01_dbdata` |
| 5. Limpeza | `down -v`, `rmi` das duas imagens, verificar que não sobra nada | ✅ Sem contentores, volumes nem imagens da PL01 |
