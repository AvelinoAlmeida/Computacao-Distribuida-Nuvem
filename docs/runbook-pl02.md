# Runbook PL02: Kubernetes local com k3d

Ambiente: Windows 11 + WSL2 (Ubuntu) + Docker Desktop.
Pasta de trabalho: `~/cdn/pl02` (a ficha usa `~/pl02`).
Todos os comandos correm no terminal Ubuntu, a partir de `~/cdn/pl02`.

---

## 0. Preparação

### 0.0 Copiar o código do zip

```bash
mkdir -p ~/cdn/pl02
cp -r /mnt/c/Users/Avelino/Downloads/MEI.CDN-2627-PL02/code/. ~/cdn/pl02/   # copia o conteúdo de code/ para a pasta de trabalho
```

Se a cópia trouxer a pasta do zip e lixo do macOS:

```bash
cd ~/cdn/pl02
cp -r MEI.CDN-2627-PL02/code/. .        # traz app/, k8s/, README.md e registries.yaml para a raiz
rm -rf MEI.CDN-2627-PL02                # apaga a pasta do zip, incluindo __MACOSX
find . -name '._*' -print -delete       # apaga ficheiros residuais do macOS
```

Estrutura final: `app/`, `k8s/`, `README.md`, `registries.yaml`.

### 0.1 Instalar kubectl e k3d

```bash
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"  # descarrega o kubectl
sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl   # instala-o onde o sistema encontra comandos
rm kubectl                                                            # apaga a cópia descarregada
curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash   # instala o k3d
```

```bash
kubectl version --client    # confirma o kubectl
k3d version                 # confirma o k3d e a versão do k3s
```

- `kubectl`: cliente que fala com a API do cluster.
- `k3d`: cria clusters k3s em que cada nó é um contentor Docker.

### 0.2 Descarregar imagens antes da aula

```bash
docker pull node:22-alpine                                  # imagem base da app
k3d cluster create teste --registry-config registries.yaml  # cluster de teste, só para descarregar as imagens do k3d
k3d cluster delete teste                                    # apaga-o logo a seguir
docker images                                               # deve listar node, rancher/k3s e k3d-proxy
```

---

## 1. Criar o cluster

```bash
docker ps   # confirma que nenhum contentor usa a porta 8080
k3d cluster create cdn --servers 1 --agents 2 -p "8080:80@loadbalancer" --registry-config registries.yaml
```

- `--servers 1`: um nó de plano de controlo.
- `--agents 2`: dois nós de trabalho.
- `-p "8080:80@loadbalancer"`: porta 8080 do portátil para a porta 80 do cluster (Traefik).
- `--registry-config`: os nós descarregam imagens através do mirror `mirror.gcr.io`.

```bash
kubectl get nodes                       # 3 nós em Ready
kubectl config current-context          # k3d-cdn
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'   # 4 contentores, serverlb com 8080->80
kubectl get pods -A                     # Pods de sistema; repetir até Running ou Completed
```

---

## 2. Deployments com nginx

### 2.1 Imperativo (ordens diretas)

```bash
kubectl create deployment hello --image=nginx:alpine --replicas=2   # cria Deployment com 2 Pods
kubectl get pods -o wide                                            # mostra em que nó corre cada Pod
kubectl scale deployment hello --replicas=5                         # passa para 5 Pods
kubectl get replicaset                                              # DESIRED 5
kubectl delete pod <nome-de-um-pod>                                 # apaga um Pod
kubectl get pods -l app=hello                                       # o ReplicaSet criou outro: continuam 5
```

### 2.2 Declarativo (ficheiro YAML)

```bash
kubectl delete deployment hello
kubectl create deployment hello --image=nginx:alpine --replicas=2 --dry-run=client -o yaml > hello.yaml  # gera YAML sem criar nada
kubectl apply -f hello.yaml        # cria a partir do ficheiro: "created"
```

Editar `hello.yaml`: `replicas: 2` para `replicas: 4`.

```bash
kubectl diff -f hello.yaml         # compara ficheiro com cluster, sem alterar
kubectl apply -f hello.yaml        # aplica: "configured"
kubectl delete -f hello.yaml       # apaga tudo o que o ficheiro declara
```

---

## 3. A app no cluster

```bash
docker build -t cdn-app:1.0 app                      # constrói a imagem (app = pasta do Dockerfile)
k3d image import cdn-app:1.0 -c cdn                  # copia a imagem para os nós (não veem o Docker do portátil)
docker exec k3d-cdn-agent-0 crictl images | grep cdn-app   # confirma que o nó tem a imagem
```

```bash
kubectl apply --dry-run=server -f k8s/app-deployment.yaml -f k8s/app-service.yaml  # valida no cluster sem criar
kubectl apply -f k8s/app-deployment.yaml -f k8s/app-service.yaml                   # cria Deployment (3 réplicas) e Service
kubectl rollout status deployment/app                                              # espera até estar pronto
kubectl get endpointslices -l kubernetes.io/service-name=app                       # IPs dos Pods por trás do Service
```

Inspecionar:

```bash
kubectl logs -l app=web --prefix                     # logs dos 3 Pods
kubectl describe deployment app                      # imagem, sondas, limites, tolerations
POD=$(kubectl get pods -l app=web -o name | head -1) # guarda o nome do primeiro Pod
kubectl describe $POD                                # detalhe do Pod, com Events no fim
for i in 1 2 3 4 5 6; do kubectl exec deploy/app -- wget -qO- http://app/; echo; done   # pedidos ao Service por dentro do cluster
```

Port-forward (dois terminais):

```bash
kubectl port-forward service/app 8081:80   # Terminal 1: túnel para UM Pod (fica bloqueado)
curl -s http://localhost:8081/; echo       # Terminal 2: hostname sempre igual
```

---

## 4. Ingress e balanceamento

```bash
kubectl get ingressclass                   # traefik
curl -i http://localhost:8080/             # 404: Traefik responde mas não tem regras
kubectl apply -f k8s/ingress.yaml          # regra: / vai para o Service app
curl -s http://localhost:8080/; echo       # já responde a app
for i in $(seq 1 30); do curl -s http://localhost:8080/ | grep -o '"hostname":"[^"]*"'; done | sort | uniq -c   # contagem por Pod (~10 cada)
kubectl describe ingress app               # Backends com os 3 IPs dos Pods
```

---

## 5. Postgres: configuração e estado

```bash
curl -s http://localhost:8080/db; echo     # erro: DATABASE_URL is not set
kubectl apply -f k8s/db-config.yaml -f k8s/db-secret.yaml -f k8s/db-pvc.yaml   # ConfigMap, Secret e PVC
kubectl get configmap,secret,pvc           # PVC em Pending (WaitForFirstConsumer)
kubectl get secret db -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 --decode; echo   # base64 não é cifra
kubectl apply -f k8s/db-deployment.yaml -f k8s/db-service.yaml   # Postgres fixo no nó servidor
kubectl rollout status deployment/db
kubectl get pvc,pv                         # PVC agora Bound
```

Editar `k8s/app-deployment.yaml`, a seguir a `APP_VERSION`:

```yaml
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef: { name: db, key: DATABASE_URL }
```

```bash
kubectl diff -f k8s/app-deployment.yaml
kubectl apply -f k8s/app-deployment.yaml   # cria Pods novos com a variável
kubectl rollout status deployment/app
curl -s http://localhost:8080/db; echo     # {"status":"ok",...}
```

Persistência:

```bash
kubectl exec deploy/db -- psql -U app -d app -c "CREATE TABLE notas (id serial PRIMARY KEY, texto text);"
kubectl exec deploy/db -- psql -U app -d app -c "INSERT INTO notas (texto) VALUES ('sobrevive ao Pod');"
kubectl delete pod -l app=db                                         # apaga o Pod do Postgres
kubectl wait --for=condition=Ready pod -l app=db --timeout=90s       # espera pelo Pod novo
kubectl exec deploy/db -- psql -U app -d app -c "SELECT * FROM notas;"   # a linha continua lá
```

---

## 6. Rolling update e rollback

```bash
docker tag cdn-app:1.0 cdn-app:1.1         # mesma imagem, outra etiqueta
k3d image import cdn-app:1.1 -c cdn
kubectl rollout history deployment/app     # revisões 1 e 2
```

Terminal 1 (tráfego contínuo, numa só linha):

```bash
while true; do curl -s -w ' %{http_code}\n' http://localhost:8080/ | sed -E 's/.*"version":"([^"]*)".*"hostname":"([^"]*)".* ([0-9]{3})$/\1 \2 \3/'; sleep 0.3; done | tee pedidos.txt
```

Terminal 2: editar `k8s/app-deployment.yaml` (`image: cdn-app:1.1` e `value: "1.1"`).

```bash
kubectl apply -f k8s/app-deployment.yaml
kubectl rollout status deployment/app
kubectl get replicaset                     # antigo com DESIRED 0, novo com 3
awk '{print $1, $3}' pedidos.txt | sort | uniq -c   # só códigos 200
```

Rollback:

```bash
kubectl rollout undo deployment/app        # volta à revisão anterior
kubectl rollout history deployment/app     # 1, 3, 4
kubectl get deployment app -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'   # cdn-app:1.0
cp k8s/solucao/app-deployment-s5.yaml k8s/app-deployment.yaml   # alinha o ficheiro com o cluster
```

Atualização falhada:

```bash
kubectl set image deployment/app app=cdn-app:9.9   # imagem que não existe
sleep 20
kubectl get pods                                   # Pod novo em ImagePullBackOff, antigos Running
kubectl get events --field-selector reason=Failed  # causa: not found
kubectl rollout undo deployment/app
```

---

## 7. Falha de nó

Escolher um agente sem o Pod do Traefik:

```bash
kubectl get pods -n kube-system -o wide | grep '^traefik-'
NODE=k3d-cdn-agent-0       # definir em cada terminal que o usa
```

Terminal 1:

```bash
while true; do curl -s --max-time 2 -w ' %{http_code}\n' http://localhost:8080/ | sed -E 's/.*"version":"([^"]*)".*"hostname":"([^"]*)".* ([0-9]{3})$/\1 \2 \3/'; sleep 0.5; done
```

Terminal 2:

```bash
kubectl get pods -o wide -w   # observa mudanças em tempo real
```

### 7.2 Saída ordenada

```bash
kubectl drain $NODE --ignore-daemonsets --delete-emptydir-data   # bloqueia o nó e expulsa os Pods
kubectl get nodes                       # Ready,SchedulingDisabled
kubectl uncordon $NODE                  # volta a aceitar Pods
kubectl rollout restart deployment/app  # recria Pods para usarem o nó outra vez
```

### 7.3 Falha abrupta

```bash
docker stop $NODE                       # desliga o nó sem aviso
kubectl get nodes                       # NotReady
kubectl describe node $NODE | grep -A3 Taints   # taints unreachable
kubectl get pods -o wide                # após 30 s: Pod antigo Terminating, novo noutro nó
```

### 7.4 Repor

```bash
docker start $NODE
sleep 20
kubectl get nodes                       # 3 nós Ready
kubectl get pods -o wide                # sem Terminating
```

### 7.5 Limpeza

```bash
k3d cluster delete cdn                  # apaga cluster, volume e contexto
docker rmi cdn-app:1.0 cdn-app:1.1      # apaga as imagens da app
```

---

## Resultados obtidos (8 de outubro de 2026)

Corrida completa com kubectl 1.37 e k3d 5.9.0 (k3s 1.35.5). O código da ficha está em `pl02/` neste repositório.

| Secção | Medição | Resultado |
|---|---|---|
| 1 | `kubectl get nodes` | 3 nós `Ready`; 4 contentores, `serverlb` com `8080->80` |
| 2.1 | apagar 1 de 5 Pods `hello` | ReplicaSet recria-o: continuam 5 |
| 3 | Pods da app | 1 por nó (server-0, agent-0, agent-1); 3 IPs no EndpointSlice |
| 3 | 6 pedidos via `kubectl exec` ao Service | alternam pelos 3 Pods |
| 3 | 3 pedidos via port-forward | sempre o mesmo Pod |
| 4 | 30 pedidos pelo Ingress | 11 / 10 / 9 por Pod |
| 5 | `/db` antes / depois do Secret | `DATABASE_URL is not set` / `{"status":"ok",...}` |
| 5 | Pod do Postgres | no `server-0` (nodeSelector); PVC `Pending` → `Bound` |
| 5 | `SELECT * FROM notas` após apagar o Pod | `sobrevive ao Pod` |
| 6 | Rolling update 1.0 → 1.1 com tráfego | 64 pedidos: 35 × `1.0 200`, 29 × `1.1 200`, nenhum erro |
| 6 | Rollback | revisões 1, 3, 4; imagem `cdn-app:1.0` |
| 6 | `cdn-app:9.9` | 1 Pod em `ImagePullBackOff`, 3 antigos `Running`, app sempre a responder |
| 7.2 | `drain` + `uncordon` + `rollout restart` com tráfego | 150 pedidos, todos `200` |
| 7.3 | `docker stop` de `agent-1` | `NotReady` ao fim de ~50 s; Pod substituto criado ~20 s depois (30 s de tolerância contados desde a perda de contacto) |
| 7.3 | Pedidos durante a falha (~1 m 45 s) | 141 pedidos: 124 × `200`, 17 × `000` (~12 %) |
| 7.4 | `docker start` | 3 nós `Ready` ao fim de 20 s; sem Pods em `Terminating` |

---

## Problemas encontrados

| Situação | Causa | Solução |
|---|---|---|
| Pasta `MEI.CDN-2627-PL02`, `__MACOSX` e `._code` dentro de `~/cdn/pl02` | Zip copiado com a pasta de topo e ficheiros do macOS | Copiar o conteúdo de `code/` para a raiz e apagar o resto (0.0) |
| Aviso de versões: kubectl v1.37, k3s v1.35 | Diferença de duas versões, acima do suportado oficialmente | Sem impacto nesta ficha; atenção se algum comando falhar de forma estranha |
| `bash: syntax error near unexpected token 'newline'` | Comando corrido com `<nome-do-pod>` literal; `<` e `>` são redirecionamento | Substituir pelo nome real do Pod |
| `No resources found` ou poucos Pods logo após `create`/`apply` | O `get` correu antes de os Pods serem criados | Esperar uns segundos e repetir, ou usar `rollout status` |
| Pods antigos em `Completed`/`Terminating` misturados com os novos | Deployment anterior ainda a ser removido | Ver a coluna `AGE` e repetir |
| Um `curl /db` com erro logo após o rollout | Pedido caiu num Pod antigo em terminação | Repetir |
| `connect ECONNREFUSED` após apagar o Pod do Postgres | Service ainda sem o Pod novo como destino; a app não volta a tentar | Repetir; em produção, retries com espera na app |
| Comando `while … sed` partido em duas linhas | Paginação do PDF | Colar numa só linha |
| 6.4 sem `ImagePullBackOff` visível | `get pods` correu antes de a descarga falhar | Acrescentar `sleep 20` |
| Terminal fora de `~/cdn/pl02` | Terminal aberto noutra pasta | `cd ~/cdn/pl02` antes de comandos com `k8s/` |
| Aviso `last-applied-configuration` no `rollout undo` | O `undo` muda o cluster mas não o ficheiro | Repor o ficheiro com `cp k8s/solucao/...` |
| `000` em cerca de 1 em cada 3 pedidos durante o `docker stop` | O `serverlb` do k3d continua a enviar ligações para o nó parado | Desaparece ao repor o nó; em produção, health checks no load balancer |
| Cluster `cdn` já existente (sobra da PL03) a ocupar a 8080 | A PL03 não foi limpa até ao fim | `k3d cluster delete cdn` antes da secção 1 |
| Pods antigos ~30-40 s em `Terminating` depois de um rollout | A app não trata `SIGTERM`; o Kubernetes espera o `terminationGracePeriodSeconds` (30 s) e só então a mata | Esperar; não afeta os pedidos (o Pod já saiu do Service) |
