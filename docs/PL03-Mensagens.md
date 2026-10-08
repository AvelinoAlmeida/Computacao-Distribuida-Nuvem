# Runbook PL03: Vários serviços e mensagens

MEI · Computação Distribuída e em Nuvem · ESTG P.PORTO · 2026/27
Sessão PL03, ligada à teórica T04.

Ambiente: Windows 11 + WSL2 (Ubuntu) + Docker Desktop (Docker 29.8.2, 7,44 GiB), kubectl v1.37.1, k3d v5.9.0 (k3s v1.35.5), k6 v2.3.0.
Pasta de trabalho: `pl03/` deste repositório. No WSL é `/mnt/c/Users/Avelino/Documents/GitHub/Computacao-Distribuida-Nuvem/pl03`. A ficha usa `~/pl03`.
Todos os comandos correm no terminal Ubuntu, a partir dessa pasta:

```bash
cd /mnt/c/Users/Avelino/Documents/GitHub/Computacao-Distribuida-Nuvem/pl03
```

## Estrutura de pastas

```text
Computacao-Distribuida-Nuvem/
├── docs/
│   └── PL03-Mensagens.md                ← este runbook
└── pl03/                                ← pasta de trabalho
    ├── README.md                        ← referência de endpoints e variáveis
    ├── registries.yaml                  ← mirror do docker.io para os nós do k3d
    ├── k6/
    │   └── flash-sale.js                ← teste de carga (secções 6 e 7)
    ├── k8s/
    │   ├── secrets.yaml                 ← fornecido
    │   ├── postgres.yaml                ← fornecido (3 bases: tickets, orders, notifications)
    │   ├── rabbitmq.yaml                ← fornecido
    │   ├── tickets.yaml                 ← fornecido (ConfigMap alterado na secção 8)
    │   ├── traefik-middleware.yaml      ← fornecido (strip-prefix)
    │   ├── notifications.yaml           ← escrito pelo aluno (secção 3)
    │   ├── orders.yaml                  ← escrito pelo aluno (secção 3; ConfigMap alterado nas secções 6 e 8)
    │   └── ingress.yaml                 ← escrito pelo aluno (secção 5)
    └── services/
        ├── tickets/        Dockerfile, package.json, src/{index,lib,store,stock,redis-stock}.js
        ├── orders/         Dockerfile, package.json, src/{index,lib,amqp,outbox,tickets-client}.js
        └── notifications/  Dockerfile, package.json, src/{index,lib,amqp,delivery}.js
```

| Ficheiro | Para quê |
|---|---|
| `services/*/` | Os 3 serviços Node.js/Express. O código não é alterado na ficha |
| `services/*/src/lib.js` | Código comum, igual nos 3 serviços: logs, `/health`, `/ready`, `/metrics`, retries, graceful shutdown |
| `orders/src/tickets-client.js` | Chamada ao `tickets` com timeout, retries e o mesmo `requestId` em todas as tentativas |
| `orders/src/outbox.js` | Modo `async`: a encomenda e a mensagem são gravadas na mesma transação; um relay publica no RabbitMQ |
| `k8s/*.yaml` | Um manifesto por peça; o comportamento muda pelos ConfigMaps |
| `k6/flash-sale.js` | Carga com N VUs durante D segundos; mostra a latência, o débito, os erros e a sobrevenda |

### Nomes no Docker

Tudo o que esta ficha cria no Docker tem o prefixo `cdn-pl03`, para se distinguir de outros projetos no mesmo Docker Desktop, como o `minikube`.

| Recurso | Nome |
|---|---|
| Cluster k3d / contexto kubectl | `cdn-pl03` / `k3d-cdn-pl03` |
| Contentores dos nós | `k3d-cdn-pl03-server-0`, `k3d-cdn-pl03-agent-0`, `k3d-cdn-pl03-agent-1`, `k3d-cdn-pl03-serverlb` |
| Rede e volume | `k3d-cdn-pl03` (a rede onde o k6 corre), `k3d-cdn-pl03-images` |
| Cluster de teste (0.4) | `cdn-pl03-teste` |
| Imagens dos serviços | `cdn-pl03-tickets:1.0`, `cdn-pl03-orders:1.0`, `cdn-pl03-notifications:1.0` (os manifestos já usam estes nomes) |

## Objetivo

Montar no k3d a bilheteira de venda relâmpago: três serviços (`tickets`, `orders`, `notifications`), um Postgres com três bases e um RabbitMQ, expostos por um Ingress em `http://localhost:8080/`. Depois:
- medir o modo síncrono contra o assíncrono;
- ver a fila a funcionar como amortecedor;
- reproduzir o problema dos retries sem idempotência.

| Peça | Porta | Réplicas | Exposto no Ingress |
|---|---|---|---|
| tickets | 3001 | 2 | `/tickets` |
| orders | 3002 | 2 | `/orders` |
| notifications | 3003 | 1 | não |
| postgres | 5432 | 1 | não |
| rabbitmq | 5672 / 15672 | 1 | não |

## Regras de ouro

1. Antes de qualquer comando, confirmar que o terminal está em `pl03/`. Um terminal novo começa na home, e os caminhos relativos (`k8s/…`) falham com `No such file or directory`.
2. Colar cada bloco uma vez e carregar Enter no fim. Se a última linha ficar colada à seguinte, os comandos repetem-se ou dão erros estranhos.
3. Se um `kubectl apply -f a.yaml -f b.yaml` falhar porque um ficheiro não existe, nenhum dos dois é aplicado.
4. Mudar um ConfigMap não chega, porque o Pod só lê o ambiente ao arrancar. Depois do `apply`, fazer sempre `kubectl rollout restart`.
5. Depois de um restart, esperar que não haja Pods em `Terminating` antes de medir.
6. A correr dentro do repositório, as secções 6 e 8 alteram `k8s/orders.yaml` e `k8s/tickets.yaml`. No fim, repor com `git checkout` (secção 9).

## 0. Preparação

### 0.1 Docker na distro Ubuntu

Se `docker` não for reconhecido no Ubuntu: Docker Desktop, Settings, Resources, WSL Integration, ativar `Ubuntu`, Apply & restart, e reabrir o terminal.

```bash
docker version                      # tem de mostrar Client e Server (29.8.2)
docker info | grep "Total Memory"   # mínimo 6 GiB (aqui: 7,44 GiB)
docker ps                           # outros contentores a correr? (aqui: minikube de outro projeto)
docker stop minikube                # liberta memória durante a PL03; volta a arrancar na secção 9
```

Se a memória for inferior a 6 GiB, no PowerShell: `notepad $env:USERPROFILE\.wslconfig`, colocar `[wsl2]` e `memory=8GB`, gravar, `wsl --shutdown`, e reabrir o Docker Desktop.

### 0.2 kubectl e k3d (já instalados nesta máquina)

```bash
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl
rm kubectl
kubectl version --client            # v1.37.1

curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash
k3d version                         # v5.9.0
```

### 0.3 Código da ficha

O código já está em `pl03/` neste repositório e os manifestos estão no estado inicial (`NOTIFY_MODE: sync`, `TICKETS_TIMEOUT_MS: "2000"`, `RESPONSE_DELAY_MS: "0"`, `IDEMPOTENCY: "on"`). Se vier do zip `MEI.CDN-2627-PL03-code.zip`, copia-se o conteúdo de `code/` para a pasta de trabalho.

```bash
ls    # k6  k8s  services  registries.yaml  README.md
grep -E 'RESPONSE_DELAY_MS|IDEMPOTENCY' k8s/tickets.yaml
grep -E 'TICKETS_TIMEOUT_MS|NOTIFY_MODE' k8s/orders.yaml
```

### 0.4 Imagens base

```bash
docker pull node:22-alpine
docker pull grafana/k6                                                 # k6 v2.3.0, ~9 s
k3d cluster create cdn-pl03-teste --registry-config registries.yaml   # só para descarregar as imagens do k3d
k3d cluster delete cdn-pl03-teste
docker ps    # confirmar que nada ocupa 8080, 3001 ou 15672
```

## 1. Cluster e imagens

```bash
k3d cluster create cdn-pl03 --servers 1 --agents 2 \
  -p "8080:80@loadbalancer" \
  --registry-config registries.yaml   # ~25 s
kubectl get nodes                   # 3 nós Ready (k3d-cdn-pl03-*)
kubectl config current-context      # k3d-cdn-pl03

docker build -t cdn-pl03-tickets:1.0 services/tickets
docker build -t cdn-pl03-orders:1.0 services/orders
docker build -t cdn-pl03-notifications:1.0 services/notifications
docker images 'cdn-pl03-*'          # 3 imagens, ~66 MB de conteúdo cada

k3d image import cdn-pl03-tickets:1.0 cdn-pl03-orders:1.0 cdn-pl03-notifications:1.0 -c cdn-pl03
for n in server-0 agent-0 agent-1; do
  echo "== $n"
  docker exec k3d-cdn-pl03-$n crictl images | grep cdn-pl03
done
```

Verificação: cada um dos 3 nós lista as 3 imagens. A mensagem do `k3d image import` não prova o import; quem o prova é o `crictl`.

## 2. Infraestrutura e tickets

```bash
kubectl apply -f k8s/secrets.yaml
kubectl apply -f k8s/postgres.yaml -f k8s/rabbitmq.yaml
kubectl rollout status deployment/postgres
kubectl rollout status deployment/rabbitmq

kubectl exec deploy/postgres -- psql -U app -d postgres -At \
  -c "SELECT datname FROM pg_database WHERE NOT datistemplate;"   # postgres, tickets, orders, notifications
kubectl get pvc    # postgres-data e rabbitmq-data em Bound

kubectl apply --dry-run=server -f k8s/tickets.yaml
kubectl apply -f k8s/tickets.yaml
kubectl rollout status deployment/tickets
kubectl get pods -o wide
```

Teste com port-forward. O comando fica em primeiro plano: testar noutro terminal e terminar com Ctrl+C.

```bash
kubectl port-forward service/tickets 3001:3001
# noutro terminal:
curl -s http://localhost:3001/ready     # {"status":"ready",...,"checks":{"postgres":"ok"}}
curl -s http://localhost:3001/health
```

Nota: o port-forward para um Service fica preso a um só Pod e não faz balanceamento.

## 3. Manifestos de notifications e orders

Neste repositório, os dois ficheiros já existem com este conteúdo. O `cat >` reescreve-os sem os alterar.

### k8s/notifications.yaml

```bash
cat > k8s/notifications.yaml <<'EOF'
apiVersion: v1
kind: ConfigMap
metadata:
  name: notifications-config
data:
  CONSUMER: "on"
  PREFETCH: "10"
  NOTIFY_DELAY_MS: "500"
  PG_POOL_MAX: "10"
  LOG_LEVEL: info
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: notifications
spec:
  replicas: 1
  selector:
    matchLabels: { app: notifications }
  template:
    metadata:
      labels: { app: notifications }
    spec:
      containers:
        - name: notifications
          image: cdn-pl03-notifications:1.0
          imagePullPolicy: IfNotPresent
          ports: [{ containerPort: 3003 }]
          envFrom:
            - configMapRef: { name: notifications-config }
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef: { name: postgres, key: NOTIFICATIONS_DATABASE_URL }
            - name: RABBITMQ_URL
              valueFrom:
                secretKeyRef: { name: rabbitmq, key: RABBITMQ_URL }
          lifecycle:
            preStop:
              exec: { command: ["sleep", "5"] }
          readinessProbe:
            httpGet: { path: /ready, port: 3003 }
            periodSeconds: 5
          livenessProbe:
            httpGet: { path: /health, port: 3003 }
            initialDelaySeconds: 10
            periodSeconds: 10
          resources:
            requests: { cpu: 100m, memory: 96Mi }
            limits: { cpu: 500m, memory: 256Mi }
      tolerations:
        - key: node.kubernetes.io/not-ready
          operator: Exists
          effect: NoExecute
          tolerationSeconds: 30
        - key: node.kubernetes.io/unreachable
          operator: Exists
          effect: NoExecute
          tolerationSeconds: 30
---
apiVersion: v1
kind: Service
metadata:
  name: notifications
spec:
  selector: { app: notifications }
  ports: [{ port: 3003, targetPort: 3003 }]
EOF
```

### k8s/orders.yaml

```bash
cat > k8s/orders.yaml <<'EOF'
apiVersion: v1
kind: ConfigMap
metadata:
  name: orders-config
data:
  TICKETS_URL: http://tickets:3001
  TICKETS_TIMEOUT_MS: "2000"
  TICKETS_RETRIES: "2"
  TICKETS_BACKOFF_MS: "100"
  NOTIFY_MODE: sync
  NOTIFICATIONS_URL: http://notifications:3003
  NOTIFY_TIMEOUT_MS: "5000"
  PG_POOL_MAX: "10"
  LOG_LEVEL: info
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders
spec:
  replicas: 2
  selector:
    matchLabels: { app: orders }
  template:
    metadata:
      labels: { app: orders }
    spec:
      containers:
        - name: orders
          image: cdn-pl03-orders:1.0
          imagePullPolicy: IfNotPresent
          ports: [{ containerPort: 3002 }]
          envFrom:
            - configMapRef: { name: orders-config }
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef: { name: postgres, key: ORDERS_DATABASE_URL }
            - name: RABBITMQ_URL
              valueFrom:
                secretKeyRef: { name: rabbitmq, key: RABBITMQ_URL }
          lifecycle:
            preStop:
              exec: { command: ["sleep", "5"] }
          readinessProbe:
            httpGet: { path: /ready, port: 3002 }
            periodSeconds: 5
          livenessProbe:
            httpGet: { path: /health, port: 3002 }
            initialDelaySeconds: 10
            periodSeconds: 10
          resources:
            requests: { cpu: 100m, memory: 96Mi }
            limits: { cpu: 500m, memory: 256Mi }
      tolerations:
        - key: node.kubernetes.io/not-ready
          operator: Exists
          effect: NoExecute
          tolerationSeconds: 30
        - key: node.kubernetes.io/unreachable
          operator: Exists
          effect: NoExecute
          tolerationSeconds: 30
---
apiVersion: v1
kind: Service
metadata:
  name: orders
spec:
  selector: { app: orders }
  ports: [{ port: 3002, targetPort: 3002 }]
EOF
```

Pontos de atenção:
- os valores do ConfigMap ficam entre aspas quando são números ou `on`;
- o `selector`, as labels do template e o `selector` do Service têm de coincidir;
- `TICKETS_URL` usa a porta 3001, que é a do `tickets`.

### Aplicar e verificar

```bash
ls k8s/    # orders.yaml e notifications.yaml presentes
kubectl apply --dry-run=server -f k8s/notifications.yaml -f k8s/orders.yaml
kubectl apply -f k8s/notifications.yaml -f k8s/orders.yaml
kubectl rollout status deployment/notifications
kubectl rollout status deployment/orders
kubectl get pods    # 7 Pods em 1/1 Running

kubectl exec deploy/orders -- wget -qO- localhost:3002/ready; echo
kubectl exec deploy/notifications -- wget -qO- localhost:3003/ready; echo
```

O `notifications` mostra `postgres` e `rabbitmq` em `ok`. O `orders`, em modo `sync`, só verifica o Postgres.

## 4. Descoberta de serviços

```bash
kubectl exec deploy/orders -- cat /etc/resolv.conf
kubectl exec deploy/orders -- nslookup tickets.default.svc.cluster.local.
kubectl get service tickets

kubectl exec deploy/orders -- wget -qO- http://tickets:3001/ready; echo
kubectl exec deploy/orders -- wget -qO- http://notifications:3003/ready; echo
kubectl exec deploy/orders -- nc -zv rabbitmq 5672

kubectl get endpointslices -l kubernetes.io/service-name=tickets
kubectl get pods -l app=tickets -o wide
```

Como ler o resultado:
- o IP do `nslookup` é o `CLUSTER-IP` do Service, na gama `10.43.x`, e é estável;
- os endpoints do EndpointSlice são os IPs dos Pods, na gama `10.42.x`, e mudam quando os Pods são recriados;
- a linha `search` do `resolv.conf` permite usar só `tickets` como nome.

## 5. Ingress por caminho

### 5.1 e 5.2 Ingress sem Middleware

```bash
kubectl get ingressclass
curl -i http://localhost:8080/tickets/ready    # 404 page not found (texto): ainda não há regra
```

```bash
cat > k8s/ingress.yaml <<'EOF'
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: bilheteira
spec:
  ingressClassName: traefik
  rules:
    - http:
        paths:
          - path: /tickets
            pathType: Prefix
            backend:
              service:
                name: tickets
                port: { number: 3001 }
          - path: /orders
            pathType: Prefix
            backend:
              service:
                name: orders
                port: { number: 3002 }
EOF
kubectl apply -f k8s/ingress.yaml
curl -i http://localhost:8080/tickets/ready    # 404 em JSON: o serviço recebeu /tickets/ready
```

Os dois tipos de 404:
- **texto simples:** vem do Traefik, porque não há regra;
- **JSON com `hostname`:** vem do serviço, porque a regra existe mas o prefixo chegou ao serviço.

### 5.3 Remover o prefixo

```bash
cat > k8s/ingress.yaml <<'EOF'
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: bilheteira
  annotations:
    traefik.ingress.kubernetes.io/router.middlewares: default-strip-prefix@kubernetescrd
spec:
  ingressClassName: traefik
  rules:
    - http:
        paths:
          - path: /tickets
            pathType: Prefix
            backend:
              service:
                name: tickets
                port: { number: 3001 }
          - path: /orders
            pathType: Prefix
            backend:
              service:
                name: orders
                port: { number: 3002 }
EOF
kubectl apply -f k8s/traefik-middleware.yaml
kubectl apply -f k8s/ingress.yaml
sleep 5
curl -s http://localhost:8080/tickets/ready; echo
curl -s http://localhost:8080/orders/ready; echo
```

O Traefik pode demorar alguns segundos a ler a anotação; nesta execução demorou cerca de 2 s. Se o primeiro `curl` ainda der 404 em JSON, esperar e repetir. A anotação e o Middleware são específicos do Traefik e não funcionam noutros Ingress controllers.

### 5.4 Fluxo completo

```bash
H='Content-Type: application/json'
curl -s -X POST http://localhost:8080/tickets/events -H "$H" \
  -d '{"id":"show1","name":"Concerto","capacity":50}'; echo

RESP=$(curl -s -X POST http://localhost:8080/orders/orders -H "$H" \
  -d '{"eventId":"show1","qty":2}')
echo "$RESP"
ORDER_ID=$(echo "$RESP" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

curl -s http://localhost:8080/orders/orders/$ORDER_ID; echo
curl -s http://localhost:8080/tickets/events/show1; echo
curl -s "http://localhost:8080/orders/stats?eventId=show1"; echo
kubectl exec deploy/notifications -- wget -qO- "localhost:3003/stats?eventId=show1"; echo
curl -s http://localhost:8080/tickets/events/show1/audit; echo

for i in 1 2 3 4 5 6; do
  curl -s http://localhost:8080/tickets/health | grep -o '"hostname":"[^"]*"'
done | sort | uniq -c
```

Resultado obtido:
- encomenda `confirmed` com `"attempts":1` e `"notification":"sent"`;
- `sold` 2, `available` 48, `orders` 1;
- `sent` 1, enviada `via_http`;
- `oversold` 0;
- 6 pedidos repartidos 3 e 3 pelos dois Pods do `tickets`.

No URL `/orders/orders`, o primeiro `/orders` é o prefixo do Ingress e o segundo é a rota do serviço.

## 6. Síncrono vs assíncrono

Definir a função em cada terminal onde se vai usar o k6. O k6 corre num contentor ligado à rede do cluster e chega ao Traefik pelo `serverlb`:

```bash
k6run() {
  docker run --rm --network k3d-cdn-pl03 -v "$PWD/k6:/k6" \
    -e TICKETS_URL=http://k3d-cdn-pl03-serverlb/tickets \
    -e ORDERS_URL=http://k3d-cdn-pl03-serverlb/orders \
    "$@" grafana/k6 run --quiet /k6/flash-sale.js
}
```

### 6.1 Modo sync (duas corridas, registar a segunda)

```bash
k6run -e TARGET=orders -e VUS=10 -e DURATION=10s -e CAPACITY=100000
k6run -e TARGET=orders -e VUS=10 -e DURATION=10s -e CAPACITY=100000
```

### 6.2 Modo async

```bash
sed -i 's/NOTIFY_MODE: sync/NOTIFY_MODE: async/' k8s/orders.yaml
grep NOTIFY_MODE k8s/orders.yaml
kubectl diff -f k8s/orders.yaml          # -NOTIFY_MODE: sync / +NOTIFY_MODE: async
kubectl apply -f k8s/orders.yaml
kubectl rollout restart deployment/orders
kubectl rollout status deployment/orders
kubectl get pods    # repetir até não haver Pods orders em Terminating

k6run -e TARGET=orders -e VUS=10 -e DURATION=10s -e CAPACITY=100000
k6run -e TARGET=orders -e VUS=10 -e DURATION=10s -e CAPACITY=100000
kubectl exec deploy/rabbitmq -- rabbitmqctl list_queues -q name messages
```

### Resultados obtidos

| Métrica | sync (1.ª) | sync (2.ª) | async (1.ª) | async (2.ª) |
|---|---|---|---|---|
| pedidos | 180 | 190 | 219 | 894 |
| p95 | 801,9 ms | **620,4 ms** | 1105,0 ms | **232,7 ms** |
| mediana | 525,6 ms | **529,8 ms** | 377,0 ms | **104,5 ms** |
| débito | 17 req/s | **18 req/s** | 21 req/s | **88 req/s** |
| erros | 0 | 0 | 0 | 1 (5xx, 0,11 %) |
| fila `order.created` no fim | 0 | 0 | — | 657 |
| sobrevenda | 0 | 0 | 0 | 0 |

Como ler os resultados:
- **sync:** cada encomenda espera pelos 500 ms da notificação. Com 10 VUs a ~0,53 s por pedido, o débito fica em ≈ 18 req/s.
- **async:** o `orders` grava a encomenda e a mensagem na mesma transação e responde logo; a mensagem é publicada depois. A latência melhora porque o trabalho lento passou para a fila, não porque desapareceu. O consumidor só despacha cerca de 20 mensagens por segundo (PREFETCH 10 a dividir por 500 ms), por isso a fila cresce.
- **1.ª corrida async:** é lenta porque os Pods do `orders` acabaram de ser recriados (aquecimento do Node e do pool). É por isso que se regista a 2.ª.

## 7. A fila como amortecedor

Três terminais Ubuntu (no Windows Terminal: Ctrl+Shift+T, ou a seta ao lado do `+` e escolher Ubuntu). Em cada um, começar com o `cd` para `pl03/`.

| Terminal | Função |
|---|---|
| 1 | comandos principais e `k6run` |
| 2 (opcional) | `kubectl port-forward service/rabbitmq 15672:15672` e consola em `http://localhost:15672` (`app` / `lab-cdn-pw`) |
| 3 | ciclo de observação da fila |

Ciclo do terminal 3:

```bash
while true; do
  kubectl exec deploy/rabbitmq -- rabbitmqctl list_queues -q name messages \
    | grep -v '^name'
  sleep 5
done
```

Esperar que `order.created` chegue a 0 antes de começar. Depois da secção 6, as 657 mensagens demoraram ~37 s a esvaziar.

### 7.2 Consumidor parado

```bash
kubectl scale deployment/notifications --replicas=0
kubectl get pods    # repetir até o Pod notifications desaparecer (preStop de 5 s)
k6run -e TARGET=orders -e VUS=10 -e DURATION=10s -e CAPACITY=100000 -e EVENT_ID=fila1
curl -s "http://localhost:8080/orders/stats?eventId=fila1"; echo
```

Resultado obtido: 1187 encomendas, 0 erros, p95 192,1 ms, mediana 77,8 ms, 118 req/s. A fila ficou parada em 1187, nada se perde e nada é consumido.

### 7.3 O consumidor regressa

```bash
kubectl scale deployment/notifications --replicas=1
kubectl rollout status deployment/notifications

until kubectl exec deploy/rabbitmq -- rabbitmqctl list_queues -q name messages \
  | grep -q '^order.created[[:space:]]*0$'; do sleep 5; done
echo "fila vazia"

curl -s "http://localhost:8080/orders/stats?eventId=fila1"; echo
kubectl exec deploy/notifications -- wget -qO- "localhost:3003/stats?eventId=fila1"; echo
```

Resultado obtido:
- `sent` 1187, todas `via_queue`, e a DLQ a 0;
- a fila esvaziou em ~63 s, ao ritmo de ≈ 19 mensagens/s, como previsto;
- consultado a meio (aos 25 s), `sent` estava em 500 e a fila em 667. Não é perda; é a fila ainda a esvaziar.

## 8. Desafio: timeouts, retries e idempotência

### 8.1 Idempotência desligada

```bash
sed -i 's/RESPONSE_DELAY_MS: "0"/RESPONSE_DELAY_MS: "300"/' k8s/tickets.yaml
sed -i 's/IDEMPOTENCY: "on"/IDEMPOTENCY: "off"/' k8s/tickets.yaml
sed -i 's/TICKETS_TIMEOUT_MS: "2000"/TICKETS_TIMEOUT_MS: "100"/' k8s/orders.yaml
grep -E 'RESPONSE_DELAY_MS|IDEMPOTENCY' k8s/tickets.yaml
grep TICKETS_TIMEOUT_MS k8s/orders.yaml

kubectl apply -f k8s/tickets.yaml -f k8s/orders.yaml
kubectl rollout restart deployment/tickets deployment/orders
kubectl rollout status deployment/tickets
kubectl rollout status deployment/orders
kubectl get pods    # sem Terminating

H='Content-Type: application/json'
curl -s -X POST http://localhost:8080/tickets/events -H "$H" \
  -d '{"id":"desafio-off","name":"Desafio","capacity":1000}'; echo
for i in $(seq 1 20); do
  curl -s -o /dev/null -w '%{http_code}\n' \
    -X POST http://localhost:8080/orders/orders -H "$H" \
    -d '{"eventId":"desafio-off","qty":1}'
done | sort | uniq -c
curl -s "http://localhost:8080/orders/stats?eventId=desafio-off"; echo
curl -s http://localhost:8080/tickets/events/desafio-off/audit; echo
curl -s -X POST http://localhost:8080/orders/orders -H "$H" \
  -d '{"eventId":"desafio-off","qty":1}'; echo
```

### 8.2 Idempotência ligada

```bash
sed -i 's/IDEMPOTENCY: "off"/IDEMPOTENCY: "on"/' k8s/tickets.yaml
kubectl apply -f k8s/tickets.yaml
kubectl rollout restart deployment/tickets
kubectl rollout status deployment/tickets
kubectl get pods    # sem Terminating

curl -s -X POST http://localhost:8080/tickets/events -H "$H" \
  -d '{"id":"desafio-on","name":"Desafio","capacity":1000}'; echo
for i in $(seq 1 20); do
  curl -s -o /dev/null -w '%{http_code}\n' \
    -X POST http://localhost:8080/orders/orders -H "$H" \
    -d '{"eventId":"desafio-on","qty":1}'
done | sort | uniq -c
curl -s "http://localhost:8080/orders/stats?eventId=desafio-on"; echo
curl -s http://localhost:8080/tickets/events/desafio-on/audit; echo
curl -s -X POST http://localhost:8080/orders/orders -H "$H" \
  -d '{"eventId":"desafio-on","qty":1}'; echo
```

### Resultados obtidos

| | IDEMPOTENCY=off | IDEMPOTENCY=on |
|---|---|---|
| Códigos HTTP (20 encomendas) | 20 × 504 | 20 × 201 |
| Encomendas no orders | 0 | 20 |
| `sold` / `reservations` no /audit | 60 (63 depois de mais uma encomenda) | 20 (21 depois de mais uma encomenda) |
| `attempts` na encomenda extra | 3, `tickets_unavailable` | 2, `confirmed`, `notification: queued` |
| `oversold` | 0 (capacidade 1000) | 0 |

Desta vez o valor bate exatamente com a teoria: 20 encomendas × 3 tentativas = 60 reservas. A encomenda extra fez `sold` subir exatamente 3 (60 para 63), uma reserva por tentativa. Na execução anterior (7/10) deu 59, provavelmente por uma tentativa ter apanhado um Pod a arrancar logo a seguir ao restart. Esta execução esperou que não houvesse Pods em `Terminating` antes de medir.

Com `on`, a encomenda extra também precisou de 2 tentativas: a primeira esgotou os 100 ms. Mas o `tickets` reconheceu o mesmo `requestId` e só reservou uma vez (`sold` 20 → 21).

### 8.3 Respostas

**1. Com `off`, o que viu o cliente?** Recebeu 504 em todas as encomendas, e o `orders` não registou nenhuma. Mesmo assim, o `tickets` reservou 60 bilhetes: o `orders` fez 3 tentativas por encomenda (1 mais 2 retries) e todas reservaram. O trabalho foi feito; a resposta é que chegou depois do timeout. Ficaram reservas órfãs.

**2. Porque é que o `orders` não sabe se a reserva aconteceu?** Depois de um timeout, o cliente não consegue distinguir entre pedido perdido, servidor em falha e resposta perdida (T&VS, cap. 8; slide 14 da T04). Sem retries, a chamada é at-most-once. Com retries passa a at-least-once e pode ser executada várias vezes. A rede não garante exactly-once.

**3. O que muda com `on`?** O `requestId` funciona como chave de idempotência. O `tickets` guarda o resultado da primeira execução e, numa repetição com a mesma chave, devolve esse resultado sem reservar outra vez. O `orders` tem de reutilizar o mesmo `requestId` em todas as tentativas (`tickets-client.js`), porque é a única forma de o `tickets` reconhecer o pedido repetido. Um `requestId` novo por tentativa equivale ao caso `off`.

**4. Os retries tornaram o sistema mais fiável?**
- **Com `off`, menos:** transformaram lentidão em reservas a mais, sem aviso. Ficaram 20 erros e 60 reservas, quando sem retries seriam 20 erros e 20 reservas.
- **Com `on`, mais:** o retry cobre a resposta perdida e a idempotência impede o efeito duplicado. Na prática, at-least-once mais idempotência dá o efeito de exactly-once (T04, slide 12).
- **Fica por resolver:** o caso em que a reserva é feita mas a encomenda falha depois. O stock não é reposto, o que exige compensação (sagas, T05 e T06).

## 9. Limpeza

```bash
k3d cluster delete cdn-pl03
docker rmi cdn-pl03-tickets:1.0 cdn-pl03-orders:1.0 cdn-pl03-notifications:1.0
k3d cluster list              # sem cdn-pl03
docker images 'cdn-pl03-*'    # vazio
docker start minikube         # repõe o contentor do outro projeto, parado na secção 0
```

Repor os manifestos no estado inicial, para repetir a ficha e para não deixar alterações no repositório:

```bash
git checkout -- k8s/orders.yaml k8s/tickets.yaml k8s/ingress.yaml k8s/notifications.yaml
grep -E 'RESPONSE_DELAY_MS|IDEMPOTENCY' k8s/tickets.yaml        # "0" e "on"
grep -E 'TICKETS_TIMEOUT_MS|NOTIFY_MODE' k8s/orders.yaml        # "2000" e sync
```

## Resultados obtidos (8 de outubro de 2026, execução a partir de `pl03/` do repositório)

| Secção | Medição | Resultado |
|---|---|---|
| 0 | Ambiente | Docker 29.8.2 com 7,44 GiB; `minikube` parado; k6 v2.3.0 descarregado em ~9 s |
| 1 | Cluster e imagens | cluster em ~23 s; 3 builds em ~45 s (~66 MB cada); import em ~33 s; as 3 imagens nos 3 nós (`crictl`) |
| 2 | Infraestrutura | Postgres e RabbitMQ prontos em ~37 s; 4 bases; 2 PVC `Bound`; `tickets` com 2 Pods (agent-0 e agent-1) |
| 3 | notifications e orders | 7 Pods `Running`; `/ready` do `notifications` com `postgres` e `rabbitmq` `ok` |
| 4 | DNS | `tickets` → `10.43.127.188` (ClusterIP); EndpointSlice com `10.42.1.6` e `10.42.3.4` (Pods); `nc` para `rabbitmq:5672` com `open` |
| 5 | Ingress | 404 em texto → 404 em JSON → `200` com o Middleware (~2 s); fluxo completo `confirmed`, `sent` via HTTP; 3/3 por Pod |
| 6 | sync vs async (2.ª corrida) | p95 620 → 233 ms; mediana 530 → 105 ms; 18 → 88 req/s; fila 657 no fim |
| 7 | Fila | 1187 encomendas com o consumidor parado, fila em 1187; 1187 `sent` `via_queue` em ~63 s, DLQ 0 |
| 8 | Desafio | `off`: 20 × 504, `sold` 60 (+3 por encomenda); `on`: 20 × 201, `sold` 20 |
| 9 | Limpeza | sem cluster, imagens, rede ou volume `cdn-pl03`; `minikube` `Up`; manifestos repostos |

## Problemas encontrados

| Sintoma | Causa | Solução |
|---|---|---|
| `docker`, `kubectl` ou `k3d` não encontrados | Integração WSL desligada, ou ferramentas não instaladas nesta distro | Ativar a WSL Integration para `Ubuntu`; instalar o kubectl e o k3d (0.2) |
| `docker images 'cdn-*'cd …` e builds repetidos | Linhas coladas sem Enter entre blocos | Colar cada bloco uma vez e terminar com Enter |
| `the path "k8s/orders.yaml" does not exist` | O bloco `cat > … EOF` não foi corrido | Correr o bloco e confirmar com `ls k8s/` |
| `-bash: k8s/orders.yaml: No such file or directory` | Terminal fora de `pl03/` | Fazer `cd` para a pasta `pl03/` do repositório |
| 404 em JSON logo depois de aplicar a anotação | O Traefik ainda não tinha lido o Middleware | Esperar alguns segundos e repetir |
| `k6run: command not found` | A função foi definida noutro terminal | Redefinir a função no terminal atual |
| `sent` abaixo de `orders` | A fila ainda está a esvaziar | Esperar até `order.created` chegar a 0 e repetir |
| 1.ª corrida async lenta (p95 1105 ms, 21 req/s) | Os Pods do `orders` acabaram de ser recriados pelo restart (aquecimento) | Registar a 2.ª corrida |
| 1 erro 5xx em 894 pedidos na 2.ª corrida async | Não aparece nos logs do `orders` (só um `/ready` 503 no arranque), por isso a resposta veio do Traefik. Causa exata não provada | Erro isolado (0,11 %); repetir a corrida se for preciso um valor limpo |
| Pouca memória para a PL03 com outro cluster ativo | Um contentor `minikube` de outro projeto estava a correr no mesmo Docker Desktop | `docker stop minikube` durante a ficha e `docker start minikube` no fim; os recursos desta ficha têm o prefixo `cdn-pl03` |
| `git status` mostra `k8s/orders.yaml` e `k8s/tickets.yaml` alterados | As secções 6 e 8 mudam os ConfigMaps com `sed` dentro do repositório | `git checkout -- k8s/…` na limpeza (secção 9) |
| Comandos `wsl … bash /mnt/c/...` lançados do Git Bash não encontram o ficheiro | O Git Bash converte `/mnt/c/...` num caminho Windows | Correr no terminal Ubuntu, ou prefixar com `MSYS_NO_PATHCONV=1` |

## Ligação à T04

| Secção | Conceito da T04 |
|---|---|
| 4 | Descoberta de serviços por DNS; Service como seletor; EndpointSlices |
| 5 | Balanceamento L7 por caminho; Ingress e Ingress controller; Middleware não portável (Gateway API) |
| 6 | Comunicação síncrona vs assíncrona; desacoplamento de sincronização |
| 7 | Fila durável, mensagens persistentes, ack manual; desacoplamento temporal |
| 8 | At-most-once, at-least-once, exactly-once; timeouts, retries, chave de idempotência |

## Resumo da execução

| Ponto | O que foi feito | Resultado |
|---|---|---|
| 0. Preparação | Verificar o Docker e a memória, parar o `minikube`, descarregar `node` e `k6`, criar e apagar o cluster de teste | ✅ Ambiente pronto (7,44 GiB) |
| 1. Cluster e imagens | `k3d cluster create cdn-pl03`; build e import de `cdn-pl03-{tickets,orders,notifications}` | ✅ 3 nós `Ready`; 3 imagens em cada nó |
| 2. Infraestrutura | Secrets, Postgres (3 bases), RabbitMQ, `tickets` com 2 réplicas | ✅ PVC `Bound`; `/ready` com `ok` |
| 3. notifications e orders | Escrever e aplicar os dois manifestos | ✅ 7 Pods `Running` |
| 4. Descoberta | DNS, ClusterIP vs IPs dos Pods, ligações entre serviços | ✅ Nomes curtos resolvem; EndpointSlice com os 2 Pods |
| 5. Ingress | Regras por caminho; Middleware strip-prefix; fluxo completo | ✅ Encomenda `confirmed` e notificada; carga 3/3 pelos Pods |
| 6. sync vs async | k6 com 10 VUs durante 10 s em cada modo | ✅ async ~5× mais débito (18 → 88 req/s); ⚠️ 1 erro 5xx isolado |
| 7. Fila | Consumidor parado durante a carga, depois retomado | ✅ 1187 mensagens retidas e todas entregues `via_queue`; DLQ 0 |
| 8. Desafio | Timeout 100 ms + atraso 300 ms, com idempotência `off` e `on` | ✅ `off`: 60 reservas para 0 encomendas; `on`: 20 para 20 |
| 9. Limpeza | Apagar o cluster e as imagens, repor os manifestos, voltar a arrancar o `minikube` | ✅ Nada da PL03 no Docker; repositório limpo |
