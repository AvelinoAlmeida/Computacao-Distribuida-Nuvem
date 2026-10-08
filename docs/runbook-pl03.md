# Runbook PL03: Vários serviços e mensagens

MEI · Computação Distribuída e em Nuvem · ESTG P.PORTO · 2026/27
Sessão PL03 (7 de outubro de 2026), ligada à teórica T04.

Ambiente usado: Windows 11 com WSL2 (distro `Ubuntu`), Docker Desktop 4.94 com integração WSL ativa, kubectl 1.37.1, k3d 5.9.0 (k3s 1.35.5). Pasta de trabalho: `~/cdn/pl03` (a ficha usa `~/pl03`).

## Objetivo

Montar no k3d a bilheteira de venda relâmpago: três serviços (`tickets`, `orders`, `notifications`), um Postgres com três bases e um RabbitMQ, expostos por um Ingress em `http://localhost:8080/`. Depois medir síncrono contra assíncrono, ver a fila como amortecedor e reproduzir o problema dos retries sem idempotência.

| Peça | Porta | Réplicas | Exposto no Ingress |
|---|---|---|---|
| tickets | 3001 | 2 | `/tickets` |
| orders | 3002 | 2 | `/orders` |
| notifications | 3003 | 1 | não |
| postgres | 5432 | 1 | não |
| rabbitmq | 5672 / 15672 | 1 | não |

## Regras de ouro

1. Antes de qualquer comando, confirmar que o prompt termina em `~/cdn/pl03$`. Um terminal novo começa na home e os caminhos relativos (`k8s/…`) falham com `No such file or directory`.
2. Colar cada bloco uma vez e carregar Enter no fim. Se a última linha ficar colada à seguinte, os comandos repetem-se ou dão erros estranhos.
3. Se um `kubectl apply -f a.yaml -f b.yaml` falhar porque um ficheiro não existe, nenhum dos dois é aplicado.
4. Mudar um ConfigMap não chega: o Pod só lê o ambiente ao arrancar. Depois do `apply`, fazer sempre `kubectl rollout restart`.
5. Depois de um restart, esperar que não haja Pods em `Terminating` antes de medir.

## 0. Preparação

### 0.1 Docker na distro Ubuntu

Se `docker` não for reconhecido no Ubuntu: Docker Desktop, Settings, Resources, WSL Integration, ativar `Ubuntu`, Apply & restart, reabrir o terminal.

```bash
docker version                      # tem de mostrar Client e Server
docker info | grep "Total Memory"   # mínimo 6 GiB (aqui: 7,44 GiB)
```

Se a memória for inferior a 6 GiB, no PowerShell: `notepad $env:USERPROFILE\.wslconfig`, colocar `[wsl2]` e `memory=8GB`, gravar, `wsl --shutdown`, reabrir o Docker Desktop.

### 0.2 kubectl e k3d

```bash
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl
rm kubectl
kubectl version --client

curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash
k3d version
```

### 0.3 Código da ficha

Extrair `MEI.CDN-2627-PL03-code.zip` em Transferências com o Explorador de Ficheiros e copiar:

```bash
mkdir -p ~/cdn/pl03
cp -r /mnt/c/Users/<user>/Downloads/MEI.CDN-2627-PL03-code/code/. ~/cdn/pl03/
cd ~/cdn/pl03
ls    # k6  k8s  services  registries.yaml  README.md
```

### 0.4 Imagens base

```bash
docker pull node:22-alpine
docker pull grafana/k6
k3d cluster create teste --registry-config registries.yaml
k3d cluster delete teste
docker ps    # confirmar que não há minikube nem outros contentores a ocupar 8080, 3001 ou 15672
```

## 1. Cluster e imagens

```bash
cd ~/cdn/pl03
k3d cluster create cdn --servers 1 --agents 2 \
  -p "8080:80@loadbalancer" \
  --registry-config registries.yaml
kubectl get nodes                   # 3 nós Ready
kubectl config current-context      # k3d-cdn

docker build -t cdn-tickets:1.0 services/tickets
docker build -t cdn-orders:1.0 services/orders
docker build -t cdn-notifications:1.0 services/notifications
docker images 'cdn-*'

k3d image import cdn-tickets:1.0 cdn-orders:1.0 cdn-notifications:1.0 -c cdn
for n in server-0 agent-0 agent-1; do
  echo "== $n"
  docker exec k3d-cdn-$n crictl images | grep cdn
done
```

Verificação: cada um dos 3 nós lista as 3 imagens. A mensagem do `k3d image import` não prova o import; o `crictl` prova.

## 2. Infraestrutura e tickets

```bash
kubectl apply -f k8s/secrets.yaml
kubectl apply -f k8s/postgres.yaml -f k8s/rabbitmq.yaml
kubectl rollout status deployment/postgres
kubectl rollout status deployment/rabbitmq

kubectl exec deploy/postgres -- psql -U app -d postgres -At \
  -c "SELECT datname FROM pg_database WHERE NOT datistemplate;"
kubectl get pvc    # postgres-data e rabbitmq-data em Bound

kubectl apply --dry-run=server -f k8s/tickets.yaml
kubectl apply -f k8s/tickets.yaml
kubectl rollout status deployment/tickets
kubectl get pods -o wide
```

Teste com port-forward (fica em primeiro plano; testar noutro terminal, terminar com Ctrl+C):

```bash
kubectl port-forward service/tickets 3001:3001
# noutro terminal:
curl -s http://localhost:3001/ready
curl -s http://localhost:3001/health
```

Nota: o port-forward para um Service fixa-se num só Pod; não faz balanceamento.

## 3. Manifestos de notifications e orders

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
          image: cdn-notifications:1.0
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
          image: cdn-orders:1.0
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

Pontos de atenção: valores do ConfigMap entre aspas quando são números ou `on`; `selector`, labels do template e `selector` do Service têm de coincidir; `TICKETS_URL` fica na porta 3001 (é a do `tickets`).

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

O `notifications` mostra `postgres` e `rabbitmq` em `ok`; o `orders`, em modo `sync`, só verifica o Postgres.

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

Leitura: o IP do `nslookup` é o `CLUSTER-IP` do Service (gama `10.43.x`, estável). Os endpoints do EndpointSlice são os IPs dos Pods (gama `10.42.x`, mudam quando os Pods são recriados). A linha `search` do `resolv.conf` permite usar só `tickets`.

## 5. Ingress por caminho

### 5.1 e 5.2 Ingress sem Middleware

```bash
kubectl get ingressclass
curl -i http://localhost:8080/tickets/ready    # 404 page not found (texto): não há regra
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

Os dois tipos de 404: texto simples vem do Traefik (sem regra); JSON com `hostname` vem do serviço (regra existe, mas o prefixo chegou ao serviço).

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

O Traefik demora alguns segundos a ler a anotação. Se o primeiro `curl` ainda der 404 em JSON, esperar e repetir. A anotação e o Middleware são específicos do Traefik (não portáveis entre controllers).

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

Resultado obtido: encomenda `confirmed` com `"notification":"sent"`, `sold` 2, `orders` 1, `sent` 1 via HTTP, `oversold` 0, pedidos repartidos 3 e 3 pelos dois Pods do `tickets`. O primeiro `/orders` do caminho é o prefixo do Ingress; o segundo é a rota do serviço.

## 6. Síncrono vs assíncrono

Definir a função em cada terminal onde se vai usar o k6:

```bash
cd ~/cdn/pl03
k6run() {
  docker run --rm --network k3d-cdn -v "$PWD/k6:/k6" \
    -e TICKETS_URL=http://k3d-cdn-serverlb/tickets \
    -e ORDERS_URL=http://k3d-cdn-serverlb/orders \
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
kubectl diff -f k8s/orders.yaml
kubectl apply -f k8s/orders.yaml
kubectl rollout restart deployment/orders
kubectl rollout status deployment/orders
kubectl get pods    # repetir até não haver orders em Terminating

k6run -e TARGET=orders -e VUS=10 -e DURATION=10s -e CAPACITY=100000
k6run -e TARGET=orders -e VUS=10 -e DURATION=10s -e CAPACITY=100000
kubectl exec deploy/rabbitmq -- rabbitmqctl list_queues -q name messages
```

### Resultados obtidos

| Métrica (2.ª corrida) | sync | async |
|---|---|---|
| p95 | 600,4 ms | 180,6 ms |
| mediana | 563,1 ms | 87,0 ms |
| débito | 18 req/s | 110 req/s |
| erros | 0 | 0 |
| fila `order.created` no fim | 0 | 1433 |

Leitura: em `sync`, cada encomenda espera pelos 500 ms da notificação (10 VUs / 0,56 s ≈ 18 req/s). Em `async`, o `orders` grava a encomenda e a mensagem na mesma transação e responde; a mensagem é publicada depois. A latência melhora porque o trabalho lento passou para a fila, não porque desapareceu: o consumidor só despacha cerca de 20 mensagens por segundo (PREFETCH 10 a dividir por 500 ms).

## 7. A fila como amortecedor

Três terminais Ubuntu (Windows Terminal: Ctrl+Shift+T, ou seta ao lado do `+` e escolher Ubuntu). Em cada um, começar com `cd ~/cdn/pl03`.

| Terminal | Função |
|---|---|
| 1 | comandos principais e `k6run` |
| 2 (opcional) | `kubectl port-forward service/rabbitmq 15672:15672`, consola em `http://localhost:15672` (`app` / `lab-cdn-pw`) |
| 3 | ciclo de observação da fila |

Ciclo do terminal 3:

```bash
while true; do
  kubectl exec deploy/rabbitmq -- rabbitmqctl list_queues -q name messages \
    | grep -v '^name'
  sleep 5
done
```

Esperar que `order.created` chegue a 0 antes de começar.

### 7.2 Consumidor parado

```bash
kubectl scale deployment/notifications --replicas=0
kubectl get pods    # repetir até o Pod notifications desaparecer (preStop de 5 s)
k6run -e TARGET=orders -e VUS=10 -e DURATION=10s -e CAPACITY=100000 -e EVENT_ID=fila1
curl -s "http://localhost:8080/orders/stats?eventId=fila1"; echo
```

Resultado obtido: 1046 encomendas, 0 erros, p95 188 ms. A fila subiu para cerca de 1046.

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

Resultado obtido: `sent` 1046, todas `via_queue`, DLQ a 0. Consultado a meio da descida, `sent` estava em 580: não é perda, é a fila ainda a esvaziar.

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
| Códigos HTTP (20 encomendas) | 504 | 20 × 201 |
| Encomendas no orders | 0 | 20 |
| `sold` no /audit | 59 (62 após mais uma encomenda) | 20 |
| `attempts` numa encomenda | 3, `tickets_unavailable` | 2, `confirmed` |

Sobre o 59 em vez de 60: a causa exata não ficou provada. A hipótese mais provável é uma tentativa ter apanhado um Pod do `tickets` a arrancar ou a terminar logo após o restart. O mecanismo ficou confirmado pela encomenda extra: `sold` subiu exatamente 3 (59 para 62), uma reserva por tentativa.

### 8.3 Respostas

**1. Com `off`, o que viu o cliente?** Recebeu 504 em todas as encomendas e o `orders` não registou nenhuma. O `tickets` reservou cerca de 60 bilhetes: o `orders` fez 3 tentativas por encomenda (1 mais 2 retries) e praticamente todas reservaram. O trabalho foi feito; a resposta é que chegou depois do timeout. Ficaram reservas órfãs.

**2. Porque é que o `orders` não sabe se a reserva aconteceu?** Depois de um timeout, o cliente não distingue entre pedido perdido, servidor em falha e resposta perdida (T&VS, cap. 8; slide 14 da T04). Sem retries a chamada é at-most-once; com retries passa a at-least-once e pode executar várias vezes. Exactly-once não é garantido pela rede.

**3. O que muda com `on`?** O `requestId` funciona como chave de idempotência: o `tickets` guarda o resultado da primeira execução e devolve-o numa repetição com a mesma chave, sem reservar outra vez. O `orders` tem de reutilizar o mesmo `requestId` em todas as tentativas, porque é a única forma de o `tickets` reconhecer o pedido repetido. Um `requestId` novo por tentativa equivale ao caso `off`.

**4. Os retries tornaram o sistema mais fiável?** Com `off`, menos: transformaram lentidão em sobrevenda silenciosa (20 erros e cerca de 60 reservas, em vez de 20 erros e 20 reservas sem retries). Com `on`, mais: o retry cobre a resposta perdida e a idempotência impede o efeito duplicado. Na prática, at-least-once mais idempotência dá o efeito de exactly-once (T04, slide 12). Fica por resolver o caso em que a reserva é feita mas a encomenda falha depois: o stock não é reposto, o que exige compensação (sagas, T05 e T06).

## 9. Limpeza

```bash
k3d cluster delete cdn
docker rmi cdn-tickets:1.0 cdn-orders:1.0 cdn-notifications:1.0
k3d cluster list            # sem cdn
docker images 'cdn-*'       # vazio
```

Para repetir a ficha do início, repor os valores alterados:

```bash
sed -i 's/RESPONSE_DELAY_MS: "300"/RESPONSE_DELAY_MS: "0"/' k8s/tickets.yaml
sed -i 's/TICKETS_TIMEOUT_MS: "100"/TICKETS_TIMEOUT_MS: "2000"/' k8s/orders.yaml
sed -i 's/NOTIFY_MODE: async/NOTIFY_MODE: sync/' k8s/orders.yaml
grep -E 'RESPONSE_DELAY_MS|IDEMPOTENCY' k8s/tickets.yaml
grep -E 'TICKETS_TIMEOUT_MS|NOTIFY_MODE' k8s/orders.yaml
```

## Problemas encontrados nesta sessão

| Sintoma | Causa | Solução |
|---|---|---|
| `docker`, `kubectl`, `k3d` não encontrados | integração WSL desligada; ferramentas não instaladas nesta distro | ativar WSL Integration para `Ubuntu`; instalar kubectl e k3d (0.2) |
| `docker images 'cdn-*'cd …` e builds repetidos | linhas coladas sem Enter entre blocos | colar cada bloco uma vez e terminar com Enter |
| `the path "k8s/orders.yaml" does not exist` | o bloco `cat > … EOF` não foi corrido | correr o bloco e confirmar com `ls k8s/` |
| `-bash: k8s/orders.yaml: No such file or directory` | terminal na home, não em `~/cdn/pl03` | `cd ~/cdn/pl03` |
| 404 em JSON logo após aplicar a anotação | o Traefik ainda não tinha lido o Middleware | esperar alguns segundos e repetir |
| `k6run: command not found` | função definida noutro terminal | redefinir a função no terminal atual |
| `sent` abaixo de `orders` | fila ainda a esvaziar | esperar `order.created` a 0 e repetir |

## Ligação à T04

| Secção | Conceito da T04 |
|---|---|
| 4 | descoberta de serviços por DNS; Service como seletor; EndpointSlices |
| 5 | balanceamento L7 por caminho; Ingress e Ingress controller; Middleware não portável (Gateway API) |
| 6 | comunicação síncrona vs assíncrona; desacoplamento de sincronização |
| 7 | fila durável, mensagens persistentes, ack manual; desacoplamento temporal |
| 8 | at-most-once, at-least-once, exactly-once; timeouts, retries, chave de idempotência |
