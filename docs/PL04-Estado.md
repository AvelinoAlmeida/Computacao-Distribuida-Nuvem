# PL04 · Estado no cluster

**MEI · Computação Distribuída e em Nuvem** · 14 de outubro de 2026
Ricardo Costa · rcosta@estg.ipp.pt · Gabinete 1.3

> **Adaptação pessoal:** pasta de trabalho `~/ESTG/CDN/pl04`, dentro do repositório `Computacao-Distribuida-Nuvem` (no guia original: `~/pl04`). O código do zip já está no repositório.
> Shell: bash do terminal Ubuntu do WSL2. Editor: VS Code.

---

## Índice

1. [Objetivos](#1-objetivos)
2. [Pré-requisitos e regras do guia](#2-pré-requisitos-e-regras-do-guia)
3. [Secção 0 · Ponto de partida (OA0)](#3-secção-0--ponto-de-partida-oa0)
4. [Secção 1 · Postgres como StatefulSet (OA1)](#4-secção-1--postgres-como-statefulset-oa1)
5. [Secção 2 · Persistência e os seus limites (OA2)](#5-secção-2--persistência-e-os-seus-limites-oa2)
6. [Secção 3 · Réplica de leitura e consistência (OA3)](#6-secção-3--réplica-de-leitura-e-consistência-oa3)
7. [Secção 4 · Concorrência e sobrevenda (OA4)](#7-secção-4--concorrência-e-sobrevenda-oa4)

*(as secções seguintes são acrescentadas à medida que avançamos)*

---

## 1. Objetivos

### 1.1 Visão geral

| OA | Tema | O que fazes | Secção | Conceito da T05 |
|---|---|---|---|---|
| **OA0** | Ponto de partida | Criar cluster, construir imagens, aplicar a app da PL03 | 0 | — |
| **OA1** | Postgres como StatefulSet | **Escreves o YAML** do StatefulSet com Service headless | 1 | StatefulSet e PVC |
| **OA2** | Limites da persistência | Apagar o Pod e parar o nó do Postgres | 2 | Volumes locais presos ao nó |
| **OA3** | Réplica de leitura | Ligar uma réplica assíncrona e provocar leituras antigas | 3 | Replicação assíncrona, read-your-writes, consistência eventual |
| **OA4** | Concorrência | Medir sobrevenda com o k6 em três estratégias | 4 | Verificar e agir, ponto de serialização |
| **OA5** | Desafio obrigatório | Reiniciar o Redis vazio e com estado antigo | 5 | Cache antiga vs. vazia, fonte de verdade |

### 1.2 O percurso

```
 OA0            OA1              OA2             OA3              OA4             OA5
 ┌──────┐      ┌──────────┐     ┌─────────┐     ┌──────────┐     ┌─────────┐     ┌─────────┐
 │Montar│ ───► │Postgres  │ ──► │Parar o  │ ──► │Réplica de│ ──► │Corrida  │ ──► │Redis    │
 │a app │      │StatefulSet│    │nó       │     │leitura   │     │do stock │     │antigo   │
 └──────┘      └──────────┘     └─────────┘     └──────────┘     └─────────┘     └─────────┘
  setup         identidade       durabilidade    consistência     atomicidade     fonte de
                estável          tem limites     eventual         verdade
```

### 1.3 Cada objetivo em detalhe

**OA0 · Partir de um estado comum**
Verificar o ambiente, criar o cluster `cdn`, construir e importar as imagens, aplicar os manifestos da PL03.
Não precisas de ter acabado a PL03: o zip traz tudo.

**OA1 · Postgres como StatefulSet**
Converter o Postgres de Deployment + PVC para StatefulSet. É o único YAML que escreves de raiz.
Vais observar:

| Identidade estável | Valor |
|---|---|
| Nome do Pod | `postgres-0` |
| Nome DNS | `postgres-0.postgres` |
| PVC | `data-postgres-0` (um por réplica) |
| Depois de apagar o Pod | Volta com o mesmo nome e os dados intactos |

**OA2 · Persistência e os seus limites**

| Ação | Resultado |
|---|---|
| Apagar o Pod | Os dados ficam |
| Parar o nó | O Pod **não muda de nó**: o volume `local-path` está preso ao disco desse nó |

**OA3 · Réplica de leitura e consistência**
Juntar uma réplica com replicação em streaming assíncrona. Ligar o `tickets` a ela para as leituras.

```
        escritas                         leituras (GET /events/:id)
 tickets ──────► postgres-0 ──WAL async──► postgres-replica-0 ◄────── tickets
                 (primário)                (réplica, só leitura)
                     ▲
       /audit ───────┘  sempre do primário: fonte de verdade
```

Vais medir o atraso, ver uma leitura desatualizada logo a seguir a uma escrita e confirmar que o sistema converge.

**OA4 · Medir a concorrência**
Comparar três estratégias de stock com o k6. Contar a sobrevenda no `/audit`.

| Estratégia | Quem decide | Sobrevenda esperada |
|---|---|---|
| `naive` | Ninguém (lê, espera 50 ms, grava) | **Sim** |
| `db-atomic` | Postgres (`UPDATE` condicional) | 0 |
| `redis-atomic` | Redis (script Lua) | 0 |
| `naive` com 4 réplicas | Ninguém | **Continua** |

**OA5 · Desafio obrigatório: Redis com estado antigo**

| Redis reinicia… | Sobrevenda esperada |
|---|---|
| Vazio (Pod apagado) | 0 |
| Com instantâneo antigo | 30 |

Explicar a diferença com a T05: fonte de verdade e cache antiga.

### 1.4 Arquitetura no fim da sessão

```
                         http://localhost:8080
                                 │
                       ┌─────────▼─────────┐
                       │ Traefik (Ingress) │
                       └───┬──────────┬────┘
                           │          │
                 ┌─────────▼──┐   ┌───▼────────┐      ┌───────────────┐
                 │ tickets ×2 │   │ orders ×2  │─────►│   RabbitMQ    │
                 └─┬──┬────┬──┘   └─────┬──────┘      └───────┬───────┘
                   │  │    │            │                     │
      escritas     │  │    │ leituras   │             ┌───────▼───────┐
      e /audit     │  │    │            │             │ notifications │
                   │  │    │            │             └───────────────┘
        ┌──────────▼──▼┐   │   ┌────────▼────┐
        │  postgres-0  │───┼──►│  postgres-  │
        │  (primário)  │WAL│   │  replica-0  │
        └──────┬───────┘   │   └──────┬──────┘
               │           │          │
        data-postgres-0    │   PVC da réplica
                           │
                    ┌──────▼─────┐
                    │   Redis    │  (só com redis-atomic)
                    └────────────┘
```

### 1.5 O que escreves vs. o que é fornecido

| Escreves ou alteras | Fornecido completo |
|---|---|
| `k8s/postgres-statefulset.yaml` (de raiz) | Código dos três serviços |
| `k8s/tickets.yaml` (`READ_DATABASE_URL`, `STOCK_STRATEGY`) | `k8s/postgres-replica.yaml` |
| | `k8s/redis.yaml` |
| | `k6/flash-sale.js` e `k6/run.sh` |

Não escreves código de aplicação. Escreves YAML, corres comandos e medes.

---

## 2. Pré-requisitos e regras do guia

### 2.1 O que tens de ter

| Requisito | Mínimo | Como confirmar |
|---|---|---|
| Windows com WSL2 (Ubuntu) | — | Abrir o terminal Ubuntu |
| Docker Desktop com integração WSL | Engine ≥ 25 | `docker version` mostra **Client** e **Server** |
| `kubectl` dentro do Ubuntu | Como na PL02 | `which kubectl` → caminho Linux, **não** `.exe` |
| `k3d` dentro do Ubuntu | ≥ 5.6 | `k3d version` |
| Memória do WSL2 | 8 GB (portátil de 16 GB) | `free -h` → linha `Mem` |
| Porta `8080` livre | — | `ss -ltn \| grep :8080` não devolve nada |
| Internet durante a sessão | — | Os nós descarregam imagens |
| Código do PL04 | `MEI.CDN-2627-PL04-code.zip` | Já o tens |

**Pouca memória?** Com menos de 6 GB no WSL2, usa o cluster com 1 agente (Secção 0.2).

**Imagens que o cluster vai descarregar:** Traefik, CoreDNS, `postgres:17-alpine`, `rabbitmq:4-management-alpine`, `redis:8-alpine`.

Não precisas de ter terminado a PL03.

### 2.2 Verificação rápida

No terminal Ubuntu:

```bash
docker version --format 'Client {{.Client.Version}} | Server {{.Server.Version}}'
which kubectl k3d
k3d version
kubectl version --client
free -h | grep Mem
ss -ltn | grep ':8080' || echo "8080 livre"
```

| Resultado esperado | Se falhar |
|---|---|
| Duas versões, Server ≥ 25 | Docker Desktop parado ou sem integração WSL |
| Caminhos `/usr/local/bin/...` | Instalar no Ubuntu, não usar os `.exe` |
| `k3d version v5.6` ou superior | Atualizar o k3d |
| `Mem` total perto de 8 GB | Ajustar `.wslconfig` e `wsl --shutdown` |
| `8080 livre` | Parar o processo que usa a porta |

### 2.3 Regras do guia

| Regra | Porquê |
|---|---|
| Usar **só** o bash do Ubuntu (WSL2) | O PowerShell retira as aspas do JSON → `curl` dá `400` |
| Nunca PowerShell, `cmd`, Git Bash nem terminal do Docker Desktop | Mesma razão |
| Copiar comandos do `.md`, **não do PDF** | O PDF parte linhas longas e deixa variáveis vazias |
| Pasta na home Linux: `~/ESTG/CDN/pl04` | Nunca em `C:\...` nem em `/mnt/c/...` |
| Comandos com `\` no fim da linha | Copiar o bloco inteiro |
| Texto entre `<…>` | Substituir pelo valor real, sem `<` e `>` |
| Todos os comandos correm a partir de `~/ESTG/CDN/pl04` | Os caminhos `k8s/`, `k6/` são relativos |

### 2.4 Como o guia está organizado

```
 Secção 0 ─► Secção 1 ─► Secção 2 ─► Secção 3 ─► Secção 4 ─► Secção 5
                     cada uma termina com
                 ✅ Verificação  +  Resolução de problemas
```

Um passo falha? Lê a caixa de resolução de problemas dessa secção. Persiste? Chama o docente ou trabalha em par.

---

## 3. Secção 0 · Ponto de partida (OA0)

**Objetivo:** a aplicação da PL03 completa num cluster `cdn` novo, exposta em `http://localhost:8080/`.

```
 0.1 Ambiente ─► 0.2 Cluster ─► 0.3 Imagens ─► 0.4 Aplicação ─► 0.5 Fluxo completo
```

### 3.1 Passo 0.1 · Ambiente e imagens base

```bash
cd ~/ESTG/CDN && git pull
cd pl04
bash verificar-ambiente.sh
docker pull node:22-alpine
docker pull grafana/k6
k3d cluster create teste --registry-config registries.yaml
k3d cluster delete teste
docker images
```

| Imagem | Para quê |
|---|---|
| `node:22-alpine` | Base dos três serviços |
| `grafana/k6` | Teste de carga (Secção 4) |
| `rancher/k3s`, `k3d-proxy` | Trazidas pelo cluster de teste |

Postgres, RabbitMQ e Redis **não** se descarregam aqui: os nós do cluster têm armazenamento de imagens próprio e descarregam-nas na 0.4.

✅ **Verificação:** `RESULT: OK`; `docker images` lista as quatro imagens.

### 3.2 Passo 0.2 · Criar o cluster

```bash
k3d cluster create cdn --servers 1 --agents 2 \
  -p "8080:80@loadbalancer" \
  --registry-config registries.yaml
kubectl get nodes
kubectl config current-context
```

```
 ┌───────────────── cluster "cdn" ─────────────────┐
 │  k3d-cdn-server-0   control-plane   Ready       │
 │  k3d-cdn-agent-0    (worker)        Ready       │
 │  k3d-cdn-agent-1    (worker)        Ready       │
 └──────────────▲──────────────────────────────────┘
                │ loadbalancer :80
      localhost:8080 (portátil)
```

| Situação | Ação |
|---|---|
| WSL2 com menos de 6 GB | `--agents 1` (2 nós; na Secção 3 a réplica fica no mesmo agente) |
| `port is already allocated` / `Ports are not available` | `-p "8090:80@loadbalancer"` e usar `8090` nos URLs |
| `cluster ... already exists` | `k3d cluster delete cdn` e repetir |
| Contexto errado | `kubectl config use-context k3d-cdn` |

✅ **Verificação:** 3 nós `Ready`; contexto `k3d-cdn`.

### 3.3 Passo 0.3 · Construir e importar as imagens

```bash
docker build -t cdn-tickets:1.1 services/tickets
docker build -t cdn-orders:1.1 services/orders
docker build -t cdn-notifications:1.1 services/notifications
k3d image import cdn-tickets:1.1 cdn-orders:1.1 cdn-notifications:1.1 -c cdn

for n in $(kubectl get nodes -o name | cut -d/ -f2); do
  echo "== $n"; docker exec $n crictl images | grep cdn-
done
```

```
 docker build ──► Docker do portátil ──k3d image import──► server-0 ┐
                                                           agent-0  ├─ crictl confirma
                                                           agent-1  ┘
```

| Erro | Causa e ação |
|---|---|
| `path "services/tickets" not found` | Fora de `~/ESTG/CDN/pl04` |
| `ErrImagePull` num Pod dos serviços | Imagem não está nesse nó: repetir o import e `kubectl rollout restart deployment/<nome>` |
| `npm ci ... did not complete` | Rede/proxy bloqueia o registo npm |

✅ **Verificação:** cada nó lista as três imagens `1.1`. A mensagem do k3d não prova o import; o `crictl` prova.

### 3.4 Passo 0.4 · Aplicar a aplicação

```bash
kubectl apply -f k8s/secrets.yaml -f k8s/postgres-init.yaml
kubectl apply -f k8s/postgres-deployment.yaml -f k8s/rabbitmq.yaml
kubectl rollout status deployment/postgres
kubectl rollout status deployment/rabbitmq

kubectl apply -f k8s/tickets.yaml -f k8s/orders.yaml -f k8s/notifications.yaml
kubectl apply -f k8s/traefik-middleware.yaml -f k8s/ingress.yaml
kubectl rollout status deployment/tickets
kubectl rollout status deployment/orders
kubectl rollout status deployment/notifications
kubectl get pods -o wide
```

```
 1. secrets + postgres-init ──► 2. postgres, rabbitmq ──► 3. tickets ×2, orders ×2, notifications
    (credenciais, scripts)        (esperar Ready)            + middleware + Ingress
```

Distribuição obtida:

| Nó | Pods |
|---|---|
| `server-0` | postgres, rabbitmq |
| `agent-0` | tickets, orders |
| `agent-1` | tickets, orders, notifications |

| Erro | Causa e ação |
|---|---|
| `exceeded its progress deadline` | Imagem ainda a descarregar: esperar e repetir o `rollout status` |
| `secret "postgres" not found` | Aplicar `k8s/secrets.yaml` |
| Pod `0/1` com `waiting for postgres` | `kubectl delete pod <nome>`; se persistir, `docker restart <nó>` |

✅ **Verificação:** 7 Pods em `1/1 Running`.

### 3.5 Passo 0.5 · Um fluxo completo

```bash
curl -s -w '\n' -X POST http://localhost:8080/tickets/events \
  -H 'Content-Type: application/json' \
  -d '{"id":"show1","name":"Concerto","capacity":50}'
curl -s -w '\n' -X POST http://localhost:8080/orders/orders \
  -H 'Content-Type: application/json' \
  -d '{"eventId":"show1","qty":2}'
curl -s -w '\n' http://localhost:8080/tickets/events/show1
curl -s -w '\n' http://localhost:8080/tickets/events/show1/audit
```

`/orders/orders`: o primeiro `/orders` é o prefixo do Ingress, o segundo a rota do serviço.

```
 curl ─► Traefik ─► orders ──HTTP──► tickets ──► Postgres (primário)
                      └──sync──► notifications
```

Resultado obtido:

| Pedido | Resultado |
|---|---|
| Criar evento | `capacity:50`, `sold:0`, `available:50` |
| Encomenda de 2 | `"status":"confirmed"`, `"attempts":1`, `"notification":"sent"` |
| Ler evento | `sold:2`, `available:48`, `"readFrom":"primary"` |
| `/audit` | `sold:2`, `oversold:0`, `reservations:1`, `"strategy":"db-atomic"` |

**Notas:**
- `readFrom` diz que base de dados respondeu. Por agora é sempre `primary`; na Secção 3 aparece `replica`.
- O `/audit` soma as reservas gravadas no Postgres principal: é a **fonte de verdade**.
- O campo `hostname` muda entre pedidos: o Service reparte a carga pelas 2 réplicas do `tickets`.

| Erro | Causa e ação |
|---|---|
| `400 bad_request` | Comando corrido no PowerShell ou copiado do PDF |
| `404 page not found` | Traefik ainda não carregou o Ingress: repetir |
| `Failed to connect ... 8080` | Cluster sem mapeamento de porta: recriar (0.2) |
| `502` / `{"error":"starting"}` | Pod ainda a arrancar: repetir |

✅ **Verificação:** encomenda `confirmed` e `sent`; `/audit` com `sold 2` e `oversold 0`.

---

## 4. Secção 1 · Postgres como StatefulSet (OA1)

**Objetivo:** dar ao Postgres identidade estável: nome fixo, DNS próprio e um volume que volta sempre ao mesmo Pod.

```
 1.1 Ponto de partida ─► 1.2 Escrever o YAML ─► 1.3 Substituir ─► 1.4 Identidade estável
```

### 4.1 Deployment vs. StatefulSet

```
 ANTES: Deployment                        DEPOIS: StatefulSet
 ┌──────────────────────────┐             ┌──────────────────────────┐
 │ postgres-8fb65cddb-7mw95 │ nome        │ postgres-0               │ nome fixo
 │  (aleatório)             │ muda        │  DNS: postgres-0.postgres│
 └────────────┬─────────────┘             └────────────┬─────────────┘
              │                                        │
       PVC postgres-data                        PVC data-postgres-0
       (criado à mão)                           (template, um por réplica)
 Service ClusterIP (IP virtual)           Service headless (clusterIP: None)
 nó: server-0 (nodeSelector)              nó: qualquer agente (affinity)
```

### 4.2 Passo 1.1 · Ponto de partida

```bash
kubectl get deployment postgres
kubectl get pods -l app=postgres -o wide
kubectl get pvc postgres-data
kubectl get service postgres
```

| Recurso | Valor obtido | Problema para uma BD |
|---|---|---|
| Pod | `postgres-8fb65cddb-7mw95` | Nome muda a cada recriação |
| Nó | `server-0` | Plano de controlo: pará-lo (Secção 2) mata o cluster |
| PVC | `postgres-data` | Criado à parte |
| Service | `ClusterIP 10.43.13.26` | IP virtual, sem nome por Pod |

### 4.3 Passo 1.2 · Escrever `k8s/postgres-statefulset.yaml`

| Campo | Deployment (PL03) | StatefulSet |
|---|---|---|
| PVC `postgres-data` | Recurso à parte | Sai → `volumeClaimTemplates` |
| Service | `ClusterIP` | Headless: `clusterIP: None` |
| `kind` | `Deployment` + `strategy` | `StatefulSet`, sem `strategy` |
| `serviceName` | — | `postgres` |
| Volume `data` | Em `volumes` | Em `volumeClaimTemplates` (em `spec`, ao lado de `serviceName`) |
| Volume `init` | Em `volumes` | Fica |
| Colocação | `nodeSelector` do servidor | `affinity`: nó **sem** `node-role.kubernetes.io/control-plane` |
| `tolerations` | — | `not-ready` e `unreachable`, `NoExecute`, 30 s |
| Contentor, env, sondas, recursos | — | Iguais (inclui `REPLICATION_PASSWORD`, usada na Secção 3) |

Ficheiro final (as linhas `# ◄` marcam o que mudou):

```yaml
# PL04 Secção 1: Postgres como StatefulSet com Service headless.
apiVersion: v1
kind: Service
metadata:
  name: postgres
spec:
  clusterIP: None                        # ◄ headless: sem IP virtual, DNS por Pod
  selector: { app: postgres }
  ports: [{ port: 5432, targetPort: 5432 }]
---
apiVersion: apps/v1
kind: StatefulSet                        # ◄ era Deployment
metadata:
  name: postgres
spec:
  serviceName: postgres                  # ◄ liga ao Service headless
  replicas: 1
  selector:
    matchLabels: { app: postgres }
  template:
    metadata:
      labels: { app: postgres }
    spec:
      affinity:                          # ◄ qualquer nó exceto o plano de controlo
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: node-role.kubernetes.io/control-plane
                    operator: DoesNotExist
      tolerations:                       # ◄ iguais às do tickets.yaml
        - key: node.kubernetes.io/not-ready
          operator: Exists
          effect: NoExecute
          tolerationSeconds: 30
        - key: node.kubernetes.io/unreachable
          operator: Exists
          effect: NoExecute
          tolerationSeconds: 30
      containers:
        - name: postgres
          image: postgres:17-alpine
          # ... env, sondas, volumeMounts e resources iguais ao Deployment ...
      volumes:                           # ◄ só fica o init
        - name: init
          configMap:
            name: postgres-init
  volumeClaimTemplates:                  # ◄ substitui o PVC postgres-data
    - metadata:
        name: data
      spec:
        accessModes: [ReadWriteOnce]
        storageClassName: local-path
        resources:
          requests:
            storage: 1Gi
```

> **Lição aprendida:** blocos `cat > ficheiro <<'EOF' ... EOF` colam-se no **terminal**. Colados no editor, as linhas `cat >` e `EOF` ficam no YAML e o `kubectl` dá `invalid object to validate`. Corrigir com `sed -i '1d;$d' <ficheiro>`.

Validar sem criar nada:

```bash
kubectl apply --dry-run=server -f k8s/postgres-statefulset.yaml
```

Resultado obtido: `statefulset.apps/postgres created (server dry run)` e `The Service "postgres" is invalid: spec.clusterIPs[0]: ... may not change once set`. O StatefulSet está válido; o Service antigo ainda existe e um `clusterIP` não se altera.

### 4.4 Passo 1.3 · Substituir o Deployment

⚠️ O PVC antigo leva os dados: o Postgres novo começa **vazio**.

```bash
kubectl delete -f k8s/postgres-deployment.yaml
kubectl apply --dry-run=server -f k8s/postgres-statefulset.yaml
kubectl apply -f k8s/postgres-statefulset.yaml
kubectl rollout status statefulset/postgres
kubectl get statefulset postgres
kubectl get pods -l app=postgres -o wide
kubectl get pvc

kubectl rollout restart deployment/tickets deployment/orders deployment/notifications
kubectl rollout status deployment/tickets
kubectl rollout status deployment/orders
kubectl rollout status deployment/notifications

curl -s -w '\n' -X POST http://localhost:8080/tickets/events \
  -H 'Content-Type: application/json' \
  -d '{"id":"show1","name":"Concerto","capacity":50}'
curl -s -w '\n' -X POST http://localhost:8080/orders/orders \
  -H 'Content-Type: application/json' \
  -d '{"eventId":"show1","qty":2}'
```

Os serviços são reiniciados para recriarem as tabelas na BD vazia.

| Item | Resultado obtido |
|---|---|
| Pod | `postgres-0` no `k3d-cdn-agent-0` |
| PVC | `data-postgres-0` `Bound`; `postgres-data` desapareceu |
| Evento | Criado de novo com `sold:0` (BD vazia confirmada) |
| Encomenda | `confirmed`, `sent` |

### 4.5 Passo 1.4 · Identidade estável

**DNS visto de dentro do cluster:**

```bash
kubectl exec deploy/orders -- nslookup postgres-0.postgres.default.svc.cluster.local.
kubectl exec deploy/orders -- nslookup postgres.default.svc.cluster.local.
kubectl get service postgres
```

```
 postgres-0.postgres  ──►  IP do Pod postgres-0   (nome próprio, sempre este Pod)
 postgres             ──►  IPs de todos os Pods   (com 1 réplica: o mesmo IP)
 Service postgres     ──►  CLUSTER-IP = None      (headless)
```

| Nome | IP obtido |
|---|---|
| `postgres-0.postgres...` | `10.42.0.9` |
| `postgres...` | `10.42.0.9` |
| Service | `TYPE ClusterIP`, `CLUSTER-IP None` |

O `kubectl` continua a mostrar `TYPE ClusterIP`; o que o torna headless é o `None`. Com mais réplicas, `postgres` devolveria os IPs de todas e `postgres-0.postgres` continuaria a apontar só para a primeira.

**Apagar o Pod:**

```bash
kubectl get pod postgres-0
kubectl get pvc data-postgres-0
kubectl delete pod postgres-0
sleep 3
kubectl wait --for=condition=Ready pod/postgres-0 --timeout=120s
kubectl get pod postgres-0
kubectl get pvc data-postgres-0
for i in 1 2 3 4; do curl -s -w '\n' http://localhost:8080/tickets/events/show1/audit; sleep 1; done
```

```
 delete pod postgres-0
        │
        ▼
 StatefulSet recria  ──►  postgres-0  (mesmo nome, AGE de segundos)
                              │
                              └──► data-postgres-0  (mesmo PVC, AGE antiga)
                                        │
                                        └──► dados intactos: sold = 2
```

| Item | Antes | Depois |
|---|---|---|
| Pod | `postgres-0`, 76 s | `postgres-0`, **3 s** |
| PVC | `pvc-51d14cc8…`, 76 s | `pvc-51d14cc8…`, **80 s** (o mesmo) |
| 1.º `/audit` | — | `internal_error` (ligações ao Pod antigo) |
| `/audit` seguintes | — | `sold:2`, `oversold:0` nas duas réplicas do `tickets` |

### 4.6 Erros comuns

| Erro | Causa e ação |
|---|---|
| `may not change once set` (Service) | Service antigo existe: `kubectl delete -f k8s/postgres-deployment.yaml` |
| `deployments.apps "postgres" not found` | Já é StatefulSet: `rollout status statefulset/postgres` |
| `unknown field "spec.template.spec.volumeClaimTemplates"` / `spec.strategy` | `volumeClaimTemplates` vai em `spec`; StatefulSet não tem `strategy` |
| `postgres-0` `Pending`, `didn't match Pod's node affinity` | Afinidade mal escrita ou `nodeSelector` do servidor ficou |
| `FailedCreate ... may not be specified when operator is 'DoesNotExist'` | Retirar `values` da afinidade (o dry-run não deteta) |
| `internal_error` (500) depois de substituir | Serviços não recriaram as tabelas: `rollout restart` |
| `internal_error` logo após apagar o Pod | Ligações antigas: repetir o pedido |
| `pods "postgres-0" not found` no `wait` | Ainda não recriado: repetir o `wait` |

✅ **Verificação:** StatefulSet `1/1`; Pod `postgres-0`; PVC `data-postgres-0` `Bound`; `nslookup` devolve o IP do Pod; após apagar o Pod, volta com o mesmo nome e `/audit` dá `sold 2`.

**Ligação à T05 (6.3):** o StatefulSet dá identidade e volume estáveis, mas **não replica dados**. E o volume `local-path` vive no disco de um nó: é o que a Secção 2 vai testar.

---

## 5. Secção 2 · Persistência e os seus limites (OA2)

**Pergunta:** o PVC sobrevive ao Pod (Secção 1). Sobrevive à falha do **nó**?

```
 2.1 Onde está o volume ─► 2.2 Parar o nó ─► 2.3 Repor o nó
```

### 5.1 Passo 2.1 · Onde está o volume

```bash
kubectl get pod postgres-0 -o wide
kubectl describe pv $(kubectl get pvc data-postgres-0 \
  -o jsonpath='{.spec.volumeName}') | grep -A2 'Node Affinity'
```

```
 PVC data-postgres-0 ──► PV pvc-51d14cc8…
                           │
                           └── Node Affinity: kubernetes.io/hostname in [k3d-cdn-agent-0]
                                              ▲
                     o volume é uma pasta no disco deste nó; só pode ser usado aqui
```

| Item | Resultado obtido |
|---|---|
| Nó do Pod | `k3d-cdn-agent-0` |
| `Node Affinity` do PV | `kubernetes.io/hostname in [k3d-cdn-agent-0]` |

### 5.2 Passo 2.2 · Parar o nó do Postgres

**Terminal 2** (fica a observar):

```bash
cd ~/ESTG/CDN/pl04
watch -n 5 kubectl get pods -o wide
```

**Terminal 1:**

```bash
NODE=$(kubectl get pod postgres-0 -o jsonpath='{.spec.nodeName}')
echo $NODE
docker stop $NODE
for i in $(seq 1 12); do date +%T; kubectl get nodes | grep agent-0; sleep 10; done
```

Cronologia obtida:

```
 16:46:08  docker stop k3d-cdn-agent-0          (Exited 143)
 16:47:07  agent-0 → NotReady                   (~59 s: grace period de ~50 s)
 ~16:47:37 +30 s (tolerationSeconds)
           postgres-0    → Terminating, preso no agent-0
           notifications → recriado no agent-1
           tickets, orders → 0/1 (o /ready verifica o Postgres)
```

| Pod | Comportamento | Porquê |
|---|---|---|
| Sem estado (`notifications`) | Recriado noutro nó | Deployment não tem identidade a proteger |
| `tickets`, `orders` | `0/1 Running` | Vivos, mas `/ready` falha sem Postgres |
| `postgres-0` | `Terminating`, não recriado | StatefulSet nunca cria um 2.º `postgres-0` sem certeza de que o 1.º parou (mesma identidade, mesmo volume) |

Nesta execução, só o `notifications` estava no `agent-0`: o `rollout restart` da Secção 1 pôs `tickets` e `orders` no `agent-1` e no `server-0`.

**Forçar a remoção** (só depois de ver `Terminating`):

```bash
kubectl delete pod postgres-0 --force --grace-period=0
sleep 5
kubectl get pod postgres-0 -o wide
kubectl describe pod postgres-0 | grep FailedScheduling
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/tickets/ready
kubectl get pods -n kube-system -o wide | grep traefik
```

Sem o `sleep`, o `get pod` corre antes de o StatefulSet recriar o Pod e dá `NotFound`.

Resultado obtido:

```
postgres-0   0/1   Pending   <none>
FailedScheduling: 0/3 nodes are available:
  1 node(s) didn't match PersistentVolume's node affinity,
  1 node(s) didn't match Pod's node affinity/selector,
  1 node(s) had untolerated taint(s).
000
```

```
 ┌──────────────┬──────────────────────────────────────────────┬─────────────────────────────┐
 │ server-0     │ didn't match Pod's node affinity/selector    │ a affinity exclui o plano   │
 │              │                                              │ de controlo                 │
 │ agent-0      │ had untolerated taint(s)                     │ nó em baixo (unreachable)   │
 │ agent-1      │ didn't match PersistentVolume's node affinity│ o volume está no agent-0    │
 └──────────────┴──────────────────────────────────────────────┴─────────────────────────────┘
          → nenhum nó serve → postgres-0 fica Pending
```

| Nota | Explicação |
|---|---|
| Redação da mensagem | O guia diz `volume node affinity conflict`; o Kubernetes 1.35 diz `didn't match PersistentVolume's node affinity`. Mesmo significado |
| `000` em vez de `503` | O Pod `traefik` estava no `agent-0`: sem Ingress, nenhum pedido chega. Aparece `Running` porque o estado ficou congelado no último contacto com o nó |

### 5.3 Passo 2.3 · Repor o nó

```bash
docker start $NODE
for i in $(seq 1 12); do date +%T; kubectl get nodes | grep agent-0; kubectl get pod postgres-0 -o wide | tail -1; sleep 10; done

kubectl get pods -o wide
for i in 1 2 3; do curl -s -w '\n' http://localhost:8080/tickets/events/show1/audit; sleep 2; done
kubectl logs postgres-0 | grep -i recovery
```

Terminar o `watch` do terminal 2 com `Ctrl+C`.

| Item | Resultado obtido |
|---|---|
| `postgres-0` | `1/1 Running` no **mesmo** `k3d-cdn-agent-0` (nunca mudou de nó) |
| Serviços | Todos `1/1` |
| `/audit` | `sold:2`, `oversold:0` nas duas réplicas |
| Logs | `database system was not properly shut down; automatic recovery in progress` |

O disco do nó guardou os dados; o Postgres recuperou-os com o WAL, como depois de uma falha de energia.

### 5.4 Erros comuns

| Erro | Causa e ação |
|---|---|
| `docker: 'stop' requires at least 1 argument` / `No such container` | `NODE` vazia (definida noutro terminal): repetir `NODE=$(…)` |
| `watch: command not found` | `sudo apt-get install -y procps` |
| `pods "postgres-0" not found` após o `--force` | Ainda não recriado: esperar uns segundos |
| `postgres-0` `Terminating` muito depois do nó voltar | `kubectl delete pod postgres-0 --force --grace-period=0` |
| `tickets` `0/1` com `waiting for postgres` num só nó | `kubectl delete pod <nome>`; se repetir, `docker restart` desse nó |
| Nó `NotReady` após `docker start` | Esperar um minuto; se persistir, `docker restart $NODE` |

✅ **Verificação:** com o nó parado, `postgres-0` ficou `Terminating` e, depois de forçado, `Pending` com conflito de afinidade do volume; nunca mudou de nó. Após o `docker start`, voltou a `1/1 Running` no mesmo nó e o `/audit` deu `sold 2`.

**Ligação à T05 (6.3):** volumes locais "are subject to the availability of the underlying node". O `local-path` tem a durabilidade **e a disponibilidade** do disco desse nó. O StatefulSet protege a identidade, não move os dados. Para sobreviver à perda do nó é preciso armazenamento em rede (EBS, EFS…) ou **replicação**: a Secção 3.

---

## 6. Secção 3 · Réplica de leitura e consistência (OA3)

**Parte central da sessão.** Uma réplica recebe o WAL do primário em streaming e repete-o. A replicação é **assíncrona**: o primário confirma ao cliente sem esperar pela réplica.

```
 3.1 Aplicar ─► 3.2 Confirmar ─► 3.3 Ligar o tickets ─► 3.4 Medir ─► 3.5 Forçar atraso ─► 3.6 Convergir
```

```
            escritas, /audit                       leituras GET /events/:id
 tickets ─────────────────► postgres-0 ──WAL async──► postgres-replica-0 ◄──── tickets
                            (primário)    streaming    (standby, só leitura)
                            agent-0                    agent-1 (anti-afinidade)
```

### 6.1 Passo 3.1 · Aplicar a réplica

O lado do primário já está preparado pelo `replication.sh` (ConfigMap `postgres-init`), que corre só quando o volume é criado:

```bash
kubectl exec postgres-0 -- psql -U app -d postgres -At \
  -c "SELECT rolname FROM pg_roles WHERE rolreplication;"
kubectl exec postgres-0 -- grep '^host replication' \
  /var/lib/postgresql/data/pg_hba.conf

kubectl apply --dry-run=server -f k8s/postgres-replica.yaml
kubectl apply -f k8s/postgres-replica.yaml
kubectl rollout status statefulset/postgres-replica
kubectl get pods -o wide | grep postgres
```

| Parte do `postgres-replica.yaml` | Função |
|---|---|
| initContainer `basebackup` | Volume vazio → `pg_basebackup -R` copia o primário e escreve `standby.signal` + ligação |
| Contentor `postgres` | Arranca como standby e segue o WAL |
| `podAntiAffinity` | Prefere nó diferente do primário |
| Service headless | `postgres-replica` |

| Item | Resultado obtido |
|---|---|
| Roles com replicação | `app`, `replicator` |
| `pg_hba.conf` | `host replication replicator all scram-sha-256` |
| Primário | `postgres-0` no `agent-0` |
| Réplica | `postgres-replica-0` no `agent-1` |

### 6.2 Passo 3.2 · Confirmar a replicação

```bash
kubectl exec postgres-0 -- psql -U app -d postgres -x \
  -c "SELECT client_addr, state, sync_state FROM pg_stat_replication;"
kubectl exec postgres-replica-0 -- psql -U app -d postgres -At \
  -c "SELECT pg_is_in_recovery();"
kubectl exec postgres-replica-0 -- psql -U app -d tickets \
  -c "UPDATE events SET sold = 0;"
```

```
 PRIMÁRIO (postgres-0)                    RÉPLICA (postgres-replica-0)
 pg_stat_replication:                     pg_is_in_recovery() = t
   client_addr = 10.42.1.11  ◄─── é ───►  (standby)
   state       = streaming
   sync_state  = async       ← não espera pela réplica
```

| Comando | Resultado obtido |
|---|---|
| `pg_stat_replication` | `10.42.1.11`, `streaming`, `async` |
| `pg_is_in_recovery()` | `t` |
| `UPDATE` na réplica | `ERROR: cannot execute UPDATE in a read-only transaction` (correto) |

### 6.3 Passo 3.3 · Ligar o `tickets` à réplica

```
                ┌── GET /events/:id ────────► READ_DATABASE_URL ──► postgres-replica
 tickets ───────┤
                └── reservas, escritas, /audit ► DATABASE_URL ───► postgres-0 (fonte de verdade)
```

Acrescentar ao `env` de `k8s/tickets.yaml`, a seguir a `DATABASE_URL`:

```yaml
            - name: READ_DATABASE_URL
              valueFrom:
                secretKeyRef: { name: postgres, key: TICKETS_READ_DATABASE_URL }
```

Com `sed`:

```bash
sed -i '/key: TICKETS_DATABASE_URL }/a\            - name: READ_DATABASE_URL\n              valueFrom:\n                secretKeyRef: { name: postgres, key: TICKETS_READ_DATABASE_URL }' k8s/tickets.yaml
```

```bash
kubectl diff -f k8s/tickets.yaml
kubectl apply -f k8s/tickets.yaml
kubectl rollout status deployment/tickets
kubectl get pods -l app=tickets
curl -s -w '\n' http://localhost:8080/tickets/ready
curl -s -w '\n' http://localhost:8080/tickets/events/show1
```

O `apply` já faz o rollout (mudou o template do Pod).

| Pedido | Resultado obtido |
|---|---|
| `/ready` | `"checks":{"postgres":"ok","replica":"ok"}` |
| Evento | `sold:2`, `"readFrom":"replica"` |

### 6.4 Passo 3.4 · Medir o atraso

```bash
curl -s -X POST http://localhost:8080/orders/orders \
  -H 'Content-Type: application/json' \
  -d '{"eventId":"show1","qty":1}' | grep -o '"status":"[a-z]*"'
kubectl exec postgres-0 -- psql -U app -d postgres -At \
  -c "SELECT replay_lag FROM pg_stat_replication;"
curl -s -w '\n' http://localhost:8080/tickets/events/show1
```

| Medida | Resultado obtido |
|---|---|
| `replay_lag` | `00:00:00.001189` (**1,2 ms**) |
| Leitura | `sold:3` da réplica, já atualizado |

O atraso natural é tão pequeno que não se nota. Parece consistente por sorte, não por garantia.

### 6.5 Passo 3.5 · Leitura desatualizada (read-your-writes violado)

Atrasar a aplicação do WAL na réplica (recarrega sem reiniciar):

```bash
kubectl exec postgres-replica-0 -- psql -U app -d postgres \
  -c "ALTER SYSTEM SET recovery_min_apply_delay = '3s';" \
  -c "SELECT pg_reload_conf();"
kubectl exec postgres-replica-0 -- psql -U app -d postgres -At \
  -c "SHOW recovery_min_apply_delay;"
```

**a) Escrever e ler logo a seguir**

```bash
curl -s -X POST http://localhost:8080/orders/orders \
  -H 'Content-Type: application/json' \
  -d '{"eventId":"show1","qty":1}' | grep -o '"status":"[a-z]*"'
curl -s -w '\n' http://localhost:8080/tickets/events/show1
sleep 4
curl -s -w '\n' http://localhost:8080/tickets/events/show1
curl -s -w '\n' http://localhost:8080/tickets/events/show1/audit
```

```
 t=0    cliente compra 1 bilhete ──► primário: sold 4   ✔ confirmed
 t≈0    cliente lê da réplica    ──► réplica:  sold 3   ✘ não vê a própria escrita
 t=3s   réplica aplica o WAL
 t=4s   cliente lê da réplica    ──► réplica:  sold 4   ✔ convergiu
        /audit (primário)        ──► sold 4             fonte de verdade
```

| Momento | Fonte | `sold` obtido |
|---|---|---|
| Encomenda confirmada | Primário | 4 |
| Leitura imediata | Réplica | **3** |
| 4 s depois | Réplica | 4 |
| `/audit` | Primário | 4 |

**b) O atraso visto do primário**

```bash
curl -s -X POST http://localhost:8080/orders/orders \
  -H 'Content-Type: application/json' \
  -d '{"eventId":"show1","qty":1}' | grep -o '"status":"[a-z]*"'
kubectl exec postgres-0 -- psql -U app -d postgres -At \
  -c "SELECT pg_current_wal_lsn() - replay_lsn FROM pg_stat_replication;"
sleep 5
kubectl exec postgres-0 -- psql -U app -d postgres -At \
  -c "SELECT replay_lag FROM pg_stat_replication;"
```

| Medida | Resultado obtido | Significado |
|---|---|---|
| `pg_current_wal_lsn() - replay_lsn` | **1264** bytes | WAL ainda não aplicado na réplica |
| `replay_lag` | **2,84 s** | Perto dos 3 s configurados |

Se o `replay_lag` vier perto de 0, repetir: o valor é atualizado de forma assíncrona.

**c) Criar e ler logo a seguir**

```bash
curl -s -w '\n' -X POST http://localhost:8080/tickets/events \
  -H 'Content-Type: application/json' \
  -d '{"id":"show2","name":"Teatro","capacity":20}'
curl -s -w '\n' -i http://localhost:8080/tickets/events/show2 | sed -n '1p;$p'
sleep 4
curl -s -w '\n' http://localhost:8080/tickets/events/show2
```

| Pedido | Resultado obtido |
|---|---|
| Criar `show2` | Criado (`sold:0`, `available:20`) |
| Ler logo a seguir | `HTTP/1.1 404 Not Found`, `{"error":"not_found","readFrom":"replica"}` |
| 4 s depois | `show2` presente, `readFrom: replica` |

### 6.6 Passo 3.6 · Repor e convergir

```bash
kubectl exec postgres-replica-0 -- psql -U app -d postgres \
  -c "ALTER SYSTEM SET recovery_min_apply_delay = 0;" \
  -c "SELECT pg_reload_conf();"
sleep 4
curl -s -X POST http://localhost:8080/orders/orders \
  -H 'Content-Type: application/json' \
  -d '{"eventId":"show1","qty":1}' | grep -o '"status":"[a-z]*"'
curl -s -w '\n' http://localhost:8080/tickets/events/show1
curl -s -w '\n' http://localhost:8080/tickets/events/show1/audit
```

| Fonte | `sold` obtido |
|---|---|
| Evento (réplica) | 6 |
| `/audit` (primário) | 6, `oversold:0`, `reservations:5` |

Réplica e primário coincidem: **consistência eventual**.

### 6.7 Perguntas para discussão (T05)

**1. Que garantia perdeu o cliente? Qual manteve?**

| | Garantia | Evidência |
|---|---|---|
| **Perdeu** | **Read-your-writes** (T05 3.2–3.3) | Comprou e leu `sold 3` em vez de 4; criou `show2` e recebeu 404 |
| **Perdeu (potencialmente)** | **Monotonic reads** | Com 2 réplicas com atrasos diferentes, leituras seguidas podiam andar para trás |
| **Manteve** | **Consistência eventual** (T05 3.1) | Sem novas escritas, a réplica alcançou o primário (`sold 6 = 6`) |
| **Manteve** | **Durabilidade das escritas** | Tudo o que foi confirmado está no primário; o `/audit` nunca mostrou valores antigos |

Em termos de PACELC (T05 5.2): sem partição, a replicação assíncrona escolhe **latência (L)** em vez de **consistência (C)**. A escrita não espera pela réplica; o preço são leituras antigas.

**2. Porque é que o `/audit` lê sempre do primário? Quando é aceitável ler de uma réplica?**

O `/audit` mede a sobrevenda: tem de ver **todas** as vendas confirmadas. Numa réplica atrasada, `sold` vem abaixo do real e uma sobrevenda podia passar despercebida. O primário é a **fonte de verdade** (T05 8.2).

| Caso | Réplica? | Porquê |
|---|---|---|
| Mostrar "restam ~44 bilhetes" num cartaz ou página | **Sim** | Um valor com 3 s de atraso é inofensivo; a réplica alivia o primário |
| Listagens, pesquisa, relatórios, dashboards | **Sim** | Tolerância a dados ligeiramente antigos |
| Decidir se há stock para vender | **Não** | Verificar-e-agir sobre um valor antigo → sobrevenda (T05 8.1) |
| Mostrar ao cliente a compra que acabou de fazer | **Não** (ou com cuidado) | Viola read-your-writes; soluções: ler do primário após escrever, *sticky sessions* ao primário durante N s, ou `synchronous_commit = remote_apply` |
| Auditoria, faturação, contabilidade | **Não** | Exigem o estado confirmado |

**3. Se o primário falhar com escritas que a réplica ainda não recebeu?**

Perdem-se, apesar de confirmadas ao cliente. Se a réplica for promovida (failover), começa no estado em que estava: com 3 s de atraso, a última encomenda (`confirmed`) desaparecia. A perda é proporcional ao atraso no momento da falha (T05 2.3).

| | Assíncrona (atual) | Síncrona (`synchronous_standby_names` + `synchronous_commit = on`/`remote_apply`) |
|---|---|---|
| Escritas confirmadas no failover | Podem perder-se | Não se perdem |
| Latência de cada escrita | Só o primário | + round-trip à réplica |
| Réplica em baixo | Primário continua | Primário **bloqueia** escritas (salvo mais réplicas síncronas) |

PACELC outra vez: a síncrona troca latência e disponibilidade por consistência.

Nota: a réplica **não decide** stock nesta aplicação. As reservas usam `DATABASE_URL` (primário). Por isso, mesmo com a leitura desatualizada, `oversold` ficou sempre em 0.

### 6.8 Erros comuns

| Erro | Causa e ação |
|---|---|
| `postgres-replica-0` preso em `Init` | `pg_basebackup` não chega ao primário: `kubectl logs postgres-replica-0 -c basebackup` |
| `password authentication failed for user "replicator"` | Volume do primário criado antes do `replication.sh`: role não existe |
| `/ready` sem `"replica":"ok"` | `READ_DATABASE_URL` não aplicada, ou Pods antigos ainda ativos |
| `readFrom: primary` depois do 3.3 | Mesma causa: confirmar `kubectl get pods -l app=tickets` |
| `replay_lag` perto de 0 com atraso de 3 s | Medição antiga: repetir o bloco |

✅ **Verificação:** réplica `streaming`/`async`; `/ready` com `replica: ok`; `readFrom: replica`; com 3 s de atraso, leitura imediata desatualizada e 404 no evento novo; após repor, réplica e `/audit` coincidem.

---

## 7. Secção 4 · Concorrência e sobrevenda (OA4)

**Pergunta:** centenas de clientes pedem o mesmo bilhete ao mesmo tempo. Quem decide se há stock?

```
 4.1 naive ─► 4.2 db-atomic ─► 4.3 redis-atomic ─► 4.4 naive com 4 réplicas
```

### 7.1 As três estratégias (`STOCK_STRATEGY`)

```
 naive          LÊ sold ──► espera 50 ms ──► GRAVA        (verificar e agir, não atómico)
 db-atomic      UPDATE … WHERE sold + qty <= capacity      (1 instrução: o Postgres serializa)
 redis-atomic   script Lua no Redis decide ──► Postgres regista
```

### 7.2 O teste de carga

`k6/flash-sale.js` cria um evento de `CAPACITY` bilhetes, lança `VUS` utilizadores em simultâneo durante `DURATION` e pergunta o `/audit`. **OVERSOLD** = bilhetes vendidos além da capacidade, contados no Postgres.

`k6/run.sh` corre o k6 num contentor **na rede do cluster** (`--network k3d-cdn`) e entra pelo `k3d-cdn-serverlb`: dentro de um contentor, `localhost` é o próprio contentor.

**Mudar de estratégia** (o ConfigMap só é lido no arranque → aplicar **e** reiniciar):

```bash
sed -i 's/^  STOCK_STRATEGY: .*/  STOCK_STRATEGY: <estratégia>/' k8s/tickets.yaml
kubectl apply -f k8s/tickets.yaml
kubectl rollout restart deployment/tickets
kubectl rollout status deployment/tickets
kubectl get pods -l app=tickets          # esperar: nenhum Terminating
kubectl exec deploy/tickets -- printenv STOCK_STRATEGY
bash k6/run.sh -e VUS=50 -e DURATION=10s -e CAPACITY=100
```

⚠️ Pods em `Terminating` ainda atendem com a estratégia antiga e falseiam a medição.

### 7.3 Passo 4.1 · `naive`

Resultado obtido:

```
strategy      : naive
sold          : 146   (capacity 100)
OVERSOLD      : 46
requests      : 5444   accepted(201): 146   sold-out(409): 5298
errors        : 0
latency (ms)  : avg 92.0   med 104.1   p95 226.4
throughput    : 541 req/s
```

```
 pedido A: lê sold=99 ─┐
 pedido B: lê sold=99 ─┤  todos veem "há 1 bilhete"
 pedido C: lê sold=99 ─┘
          ··· 50 ms ···
 A grava ─► 100   B grava ─► 101   C grava ─► 102    ← ninguém volta a verificar
```

Os `409` (esgotado) são respostas esperadas, não erros.

### 7.4 Passo 4.2 · `db-atomic`

Resultado obtido: `sold 100`, **`OVERSOLD 0`**, 4842 pedidos, 478 req/s, p95 231 ms.

```
 UPDATE events SET sold = sold + 1 WHERE id = $1 AND sold + 1 <= capacity
        │
        ├─ pedido A: bloqueia a linha ─► 1 linha afetada ─► 201
        ├─ pedido B: espera o bloqueio ─► reavalia o WHERE ─► 0 linhas ─► 409
        └─ pedido C: espera ─► reavalia ─► 0 linhas ─► 409
                         ▲
                 o Postgres é o ponto de serialização
```

Em Read Committed, o `UPDATE` bloqueado **reavalia o `WHERE` sobre a versão nova** da linha (T05 8.1, PostgreSQL §13.2.1). Equivalente a um `UPDATE … WHERE` com lock de linha no SQL Server.

### 7.5 Passo 4.3 · `redis-atomic`

```bash
kubectl apply -f k8s/redis.yaml
kubectl rollout status deployment/redis
# depois: mudar a estratégia para redis-atomic (7.2)
```

Redis fornecido: Deployment + Service, **sem persistência** (`--save ""`, `--appendonly no`), `/data` em `emptyDir`.

Resultado obtido: `sold 100`, **`OVERSOLD 0`**, 6122 pedidos, **605 req/s**, p95 **200 ms**.

```
 pedido ──► Redis (Lua: GET, comparar, DECRBY) ──┬─ sem stock ──► 409   (o Postgres nem sabe)
                                                  └─ com stock ──► Postgres grava a venda ──► 201
```

Ponto de serialização: o Redis (uma só thread; o script Lua não é interrompido). Mais rápido porque os "esgotado" são decididos em memória e nunca tocam no Postgres.

### 7.6 Passo 4.4 · Mais réplicas não resolvem

```bash
# STOCK_STRATEGY = naive (7.2), depois:
kubectl scale deployment/tickets --replicas=4
kubectl rollout status deployment/tickets
kubectl get pods -l app=tickets
bash k6/run.sh -e VUS=50 -e DURATION=10s -e CAPACITY=100
```

Resultado obtido: `sold 137`, **`OVERSOLD 37`**, 10019 pedidos, **997 req/s**, p95 174 ms.

O débito quase **duplicou** (541 → 997 req/s), mas a sobrevenda **continua**. Mais instâncias = mais pedidos a ler o mesmo valor antigo ao mesmo tempo. O valor de OVERSOLD varia muito entre corridas: uma só corrida não diz se 4 réplicas vendem mais ou menos do que 2; o que importa é que nunca chega a 0.

**Repor** 2 réplicas e `db-atomic`:

```bash
kubectl scale deployment/tickets --replicas=2
sed -i 's/^  STOCK_STRATEGY: .*/  STOCK_STRATEGY: db-atomic/' k8s/tickets.yaml
kubectl apply -f k8s/tickets.yaml
kubectl rollout restart deployment/tickets
kubectl rollout status deployment/tickets
```

### 7.7 Tabela de resultados

| Estratégia | Réplicas | Vendidos | **OVERSOLD** | Pedidos | req/s | p95 (ms) | Erros |
|---|---|---|---|---|---|---|---|
| naive | 2 | 146 | **46** | 5444 | 541 | 226 | 0 |
| db-atomic | 2 | 100 | **0** | 4842 | 478 | 231 | 0 |
| redis-atomic | 2 | 100 | **0** | 6122 | 605 | 200 | 0 |
| naive | 4 | 137 | **37** | 10019 | 997 | 174 | 0 |

### 7.8 Perguntas para discussão (T05)

**Porque é que `db-atomic` e `redis-atomic` não sobrevendem e o `naive` sim?**

O `naive` separa a **verificação** da **ação** (verificar e agir, T05 8.1): entre ler `sold` e gravar passam 50 ms, e nesse intervalo outros pedidos leem o mesmo valor. As outras duas juntam verificação e ação numa **operação atómica** num **único ponto de serialização** (T05 8.2): um só sítio decide, uma operação de cada vez sobre o mesmo item.

**Onde está o ponto de serialização?**

| Estratégia | Ponto de serialização | Mecanismo |
|---|---|---|
| naive | **Nenhum** | Cada Pod decide sozinho com dados que podem já estar antigos |
| db-atomic | Linha do evento no Postgres | Lock de linha + reavaliação do `WHERE` (Read Committed) |
| redis-atomic | Processo Redis | Thread única + script Lua atómico |

Escalar o `tickets` multiplica os decisores sem ponto comum: mais réplicas, mais corrida (4.4).

**O que custa cada estratégia?**

| Estratégia | Dependências do `tickets` | Custos e riscos |
|---|---|---|
| naive | Postgres | Sobrevenda. Inaceitável |
| db-atomic | Postgres | Contenção na linha quente: todos os pedidos (incluindo os "esgotado") esperam pelo lock. Débito limitado por uma linha. Mas **uma só fonte de verdade** |
| redis-atomic | Postgres **+ Redis** | Mais rápido, alivia o Postgres. Mas: mais um componente para operar e monitorizar; **duas cópias do mesmo facto** (contador no Redis, vendas no Postgres) que podem divergir; se o Redis voltar com estado antigo, ninguém o corrige → Secção 5 |

O Redis é um **árbitro** rápido; a **fonte de verdade** continua a ser o Postgres (T05 8.2).

### 7.9 Erros comuns

| Erro | Causa e ação |
|---|---|
| `OVERSOLD 0` com `naive` | Configuração não chegou aos Pods: `printenv STOCK_STRATEGY`; faltou o `rollout restart` ou havia Pods `Terminating` |
| `OVERSOLD > 0` com `db-atomic`/`redis-atomic`, ou `strategy` inesperada | k6 correu com Pods antigos ainda ativos: esperar e repetir |
| Erros `5xx` com `redis-atomic` | Redis não pronto: `kubectl rollout status deployment/redis` |

✅ **Verificação:** `OVERSOLD > 0` para `naive` (2 e 4 réplicas) e `0` para `db-atomic` e `redis-atomic`; (quase) nenhum erro no k6.
