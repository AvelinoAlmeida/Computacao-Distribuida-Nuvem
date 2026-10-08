# Runbook PL01: Docker

Ambiente: Windows 11 + WSL2 (Ubuntu) + Docker Desktop (Docker Compose v5.5).
Pasta de trabalho: `~/cdn/pl01` (a ficha usa `~/pl01`).
Todos os comandos correm no terminal Ubuntu, a partir de `~/cdn/pl01`.

Baseado no `pl01/README.md` e no código da pasta `pl01/` (o enunciado `MEI.CDN-2627-PL01.md` não está no repositório).

| Ficheiro | Para quê |
|---|---|
| `app.js`, `package.json` | App Express: `GET /`, `GET /health`, `GET /db` (corre `SELECT now()` no Postgres) |
| `Dockerfile`, `.dockerignore` | Imagem da app (`node:22-alpine`, `npm ci --omit=dev`) |
| `compose.yaml` | App + Postgres com `depends_on` sem condição (primeira tentativa) |
| `compose.healthcheck.yaml` | O mesmo com `healthcheck` no Postgres e `condition: service_healthy` (a correção) |

---

## 0. Preparação

```bash
docker version                          # tem de mostrar Client e Server
docker compose version                  # Compose v2+
docker ps                               # confirmar que nada usa a porta 3000
docker pull node:22-alpine              # imagem base
docker pull postgres:17-alpine          # base de dados
```

No WSL não é preciso ter `node` instalado: a app corre sempre dentro de um contentor. Para a correr sem Docker (com Node no sistema): `npm ci && node app.js`.

---

## 1. Imagem e contentor

```bash
docker build -t cdn-app:1.0 .           # constrói a imagem a partir do Dockerfile
docker images cdn-app                   # ~63 MB de conteúdo
docker run -d --name app -p 3000:3000 cdn-app:1.0   # porta 3000 do portátil para a 3000 do contentor
curl -s localhost:3000/; echo           # hostname = id curto do contentor
curl -s localhost:3000/health; echo     # {"status":"ok",...}
curl -s localhost:3000/db; echo         # erro 500: DATABASE_URL is not set (sem base de dados)
docker logs app                         # "PL01 app listening on port 3000"
docker exec app hostname                # o mesmo id que aparece no JSON
docker stop app && docker rm app
```

---

## 2. Compose: app + Postgres (primeira tentativa)

```bash
docker compose up -d --build
for i in $(seq 1 12); do curl -s -w ' %{http_code}\n' localhost:3000/db; sleep 0.5; done   # logo após o up
docker compose ps
docker compose logs db | grep "ready to accept"
docker compose logs app
docker volume ls | grep pl01            # pl01_dbdata
docker network ls | grep pl01           # pl01_default
docker compose exec -T app getent hosts db   # o nome do serviço resolve para o IP do Postgres
```

`depends_on: [db]` só espera que o contentor do Postgres **arranque**, não que aceite ligações. Os primeiros pedidos a `/db` falham com `ECONNREFUSED` até o Postgres terminar a inicialização (na primeira vez cria a base e reinicia uma vez).

Réplicas com porta fixa:

```bash
docker compose up -d --scale app=2      # falha: Bind for 0.0.0.0:3000 failed: port is already allocated
docker compose down
```

---

## 3. Compose com healthcheck (a correção)

```bash
docker compose -f compose.healthcheck.yaml up -d --build   # db: Waiting -> Healthy, só depois app: Started
docker compose -f compose.healthcheck.yaml ps              # db com "(healthy)"
curl -s localhost:3000/db; echo                            # {"status":"ok",...} logo no primeiro pedido
```

O `healthcheck` corre `pg_isready` de 5 em 5 s; `condition: service_healthy` adia o arranque da app até ao primeiro sucesso.

---

## 4. Persistência com volume

```bash
docker compose -f compose.healthcheck.yaml exec -T db psql -U app -d app \
  -c "CREATE TABLE notas (id serial PRIMARY KEY, texto text); INSERT INTO notas (texto) VALUES ('sobrevive ao down');"
docker compose -f compose.healthcheck.yaml down        # remove contentores e rede, mantém o volume
docker volume ls | grep pl01                           # pl01_dbdata continua
docker compose -f compose.healthcheck.yaml up -d
docker compose -f compose.healthcheck.yaml exec -T db psql -U app -d app -c "SELECT * FROM notas;"   # a linha continua lá
```

---

## 5. Limpeza

```bash
docker compose -f compose.healthcheck.yaml down -v     # -v apaga também o volume pl01_dbdata
docker rmi cdn-app:1.0 pl01-app                        # imagem do passo 1 e a construída pelo Compose
docker ps -a | grep pl01                               # vazio
docker volume ls | grep pl01                           # vazio
```

---

## Resultados obtidos (8 de outubro de 2026)

| Secção | Medição | Resultado |
|---|---|---|
| 1 | `/`, `/health` | `200`; `hostname` = id do contentor (`127d0cf7fc4f`) |
| 1 | `/db` sem Compose | `500` `DATABASE_URL is not set` |
| 2 | `/db` de 0,5 em 0,5 s logo após `up` | 1 × `000`, 2 × `500 ECONNREFUSED`, depois `200` (~1,6 s até ao primeiro `ok`) |
| 2 | Logs do Postgres | `ready to accept connections` → `shut down` → `ready` (reinício da inicialização) |
| 2 | `--scale app=2` | `pl01-app-2` não arranca: porta 3000 já atribuída |
| 3 | `up` com healthcheck | `db` `Healthy` ~5 s depois; app arranca a seguir; primeiro `/db` já `200` |
| 4 | `down` + `up` sem `-v` | linha `sobrevive ao down` mantém-se |
| 5 | Depois da limpeza | sem contentores, volume ou imagens da PL01 |

---

## Problemas encontrados

| Sintoma | Causa | Solução |
|---|---|---|
| `/db` com `ECONNREFUSED` logo após `docker compose up` | `depends_on` sem condição não espera pelo Postgres pronto | `compose.healthcheck.yaml` (healthcheck + `service_healthy`); em produção, retries na app |
| Comandos seguintes de um bloco colado não correm depois de `docker compose exec` | O `exec` lê o resto do stdin | Usar `exec -T` ou correr o `exec` sozinho |
| `--scale app=2` falha com `port is already allocated` | Duas réplicas não podem publicar a mesma porta do portátil | Tirar o `ports` fixo e pôr um proxy (nginx) à frente; na PL02, Deployment + Service |
