# Runbook PL02: Kubernetes local com k3d

Ambiente: Windows 11 + WSL2 (Ubuntu) + Docker Desktop (Docker 29.8.2), kubectl v1.37.1, k3d v5.9.0 (k3s v1.35.5).
Pasta de trabalho: `pl02/` deste repositório. No WSL é `/mnt/c/Users/Avelino/Documents/GitHub/Computacao-Distribuida-Nuvem/pl02`. A ficha usa `~/pl02`.
Todos os comandos correm no terminal Ubuntu, a partir dessa pasta:

```bash
cd /mnt/c/Users/Avelino/Documents/GitHub/Computacao-Distribuida-Nuvem/pl02
```

## Estrutura de pastas

```text
Computacao-Distribuida-Nuvem/
├── docs/
│   └── PL02-Kubernetes.md              ← este runbook
└── pl02/                               ← pasta de trabalho
    ├── README.md
    ├── registries.yaml                 ← mirror do docker.io para os nós do k3d
    ├── app/
    │   ├── .dockerignore
    │   ├── Dockerfile
    │   ├── app.js
    │   ├── package-lock.json
    │   └── package.json
    └── k8s/
        ├── app-deployment.yaml         ← editado nas secções 5 e 6
        ├── app-service.yaml
        ├── ingress.yaml
        ├── db-config.yaml
        ├── db-secret.yaml
        ├── db-pvc.yaml
        ├── db-deployment.yaml
        ├── db-service.yaml
        └── solucao/
            ├── app-deployment-s5.yaml  ← app-deployment.yaml depois da secção 5
            └── app-deployment-s6.yaml  ← app-deployment.yaml depois da secção 6
```

| Ficheiro | Para quê |
|---|---|
| `app/` | A app da PL01. A única diferença é que `GET /` também devolve `version`, lido de `APP_VERSION` |
| `k8s/app-*.yaml`, `k8s/ingress.yaml` | Deployment (3 réplicas, sondas, limites, tolerations de 30 s), Service e Ingress da app |
| `k8s/db-*.yaml` | Postgres: ConfigMap, Secret, PVC, Deployment (fixo no nó servidor) e Service |
| `k8s/solucao/` | `app-deployment.yaml` como deve ficar depois das secções 5 e 6 (comparar com `diff`) |
| `registries.yaml` | `--registry-config` do k3d: os nós descarregam do `docker.io` através de `mirror.gcr.io` |

### Nomes no Docker

Tudo o que esta ficha cria no Docker tem o prefixo `cdn-pl02`. Assim, `docker ps` e `docker images` mostram logo o que pertence a este projeto. Na execução, por exemplo, apareceu também um contentor `minikube` de outro projeto.

| Recurso | Nome |
|---|---|
| Cluster k3d / contexto kubectl | `cdn-pl02` / `k3d-cdn-pl02` |
| Contentores dos nós | `k3d-cdn-pl02-server-0`, `k3d-cdn-pl02-agent-0`, `k3d-cdn-pl02-agent-1`, `k3d-cdn-pl02-serverlb` |
| Rede e volume | `k3d-cdn-pl02`, `k3d-cdn-pl02-images` |
| Cluster de teste (0.2) | `cdn-pl02-teste` |
| Imagens da app | `cdn-pl02-app:1.0`, `cdn-pl02-app:1.1` (os manifestos já usam estes nomes) |

---

## 0. Preparação

### 0.0 Código

O código já está em `pl02/` neste repositório, por isso não é preciso copiar o zip da ficha. Se o código vier do zip, copia-se o conteúdo de `code/` para a pasta de trabalho e apagam-se `__MACOSX` e os ficheiros `._*`.

### 0.1 Instalar kubectl e k3d (já instalados nesta máquina)

```bash
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"  # descarrega o kubectl
sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl   # instala-o onde o sistema encontra comandos
rm kubectl                                                            # apaga a cópia descarregada
curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash   # instala o k3d
```

```bash
kubectl version --client    # v1.37.1
k3d version                 # v5.9.0, k3s v1.35.5-k3s1
```

- `kubectl`: o cliente que fala com a API do cluster.
- `k3d`: cria clusters k3s em que cada nó é um contentor Docker.

### 0.2 Descarregar imagens antes da aula

```bash
docker pull node:22-alpine                                            # imagem base da app
k3d cluster create cdn-pl02-teste --registry-config registries.yaml   # cluster de teste, só para descarregar as imagens do k3d (~20 s)
k3d cluster delete cdn-pl02-teste                                     # apaga-o logo a seguir
docker images                                                         # deve listar node, rancher/k3s e k3d-proxy
```

---

## 1. Criar o cluster

```bash
docker ps   # confirma que nenhum contentor usa a porta 8080
k3d cluster create cdn-pl02 --servers 1 --agents 2 -p "8080:80@loadbalancer" --registry-config registries.yaml   # ~30 s
```

- `--servers 1`: um nó de plano de controlo.
- `--agents 2`: dois nós de trabalho.
- `-p "8080:80@loadbalancer"`: liga a porta 8080 do portátil à porta 80 do cluster (Traefik).
- `--registry-config`: os nós descarregam imagens através do mirror `mirror.gcr.io`.

```bash
kubectl get nodes                       # 3 nós em Ready: k3d-cdn-pl02-server-0, -agent-0, -agent-1
kubectl config current-context          # k3d-cdn-pl02
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'   # 4 contentores k3d-cdn-pl02-*; o serverlb tem 8080->80
kubectl get pods -A                     # Pods de sistema; repetir até estarem todos Running ou Completed
```

---

## 2. Deployments com nginx

### 2.1 Imperativo (ordens diretas)

```bash
kubectl create deployment hello --image=nginx:alpine --replicas=2   # cria um Deployment com 2 Pods
kubectl get pods -o wide                                            # mostra em que nó corre cada Pod
kubectl scale deployment hello --replicas=5                         # passa para 5 Pods
kubectl get replicaset                                              # DESIRED 5
kubectl delete pod <nome-de-um-pod>                                 # apaga um Pod
kubectl get pods -l app=hello                                       # o ReplicaSet criou outro: continuam 5
```

### 2.2 Declarativo (ficheiro YAML)

```bash
kubectl delete deployment hello
kubectl create deployment hello --image=nginx:alpine --replicas=2 --dry-run=client -o yaml > hello.yaml  # gera o YAML sem criar nada
kubectl apply -f hello.yaml        # cria a partir do ficheiro: "created"
```

Editar `hello.yaml`: mudar `replicas: 2` para `replicas: 4` (ou correr `sed -i 's/replicas: 2/replicas: 4/' hello.yaml`).

```bash
kubectl diff -f hello.yaml         # compara o ficheiro com o cluster, sem alterar: -replicas: 2 / +replicas: 4
kubectl apply -f hello.yaml        # aplica: "configured"
kubectl delete -f hello.yaml       # apaga tudo o que o ficheiro declara
rm hello.yaml                      # não deixar o ficheiro temporário no repositório
```

---

## 3. A app no cluster

```bash
docker build -t cdn-pl02-app:1.0 app                          # constrói a imagem (app = pasta do Dockerfile)
k3d image import cdn-pl02-app:1.0 -c cdn-pl02                 # copia a imagem para os nós (não veem o Docker do portátil)
docker exec k3d-cdn-pl02-agent-0 crictl images | grep cdn-pl02-app   # confirma que o nó tem a imagem
```

```bash
kubectl apply --dry-run=server -f k8s/app-deployment.yaml -f k8s/app-service.yaml  # valida no cluster sem criar
kubectl apply -f k8s/app-deployment.yaml -f k8s/app-service.yaml                   # cria o Deployment (3 réplicas) e o Service
kubectl rollout status deployment/app                                              # espera até estar pronto
kubectl get endpointslices -l kubernetes.io/service-name=app                       # IPs dos Pods por trás do Service
```

Inspecionar:

```bash
kubectl logs -l app=web --prefix                     # logs dos 3 Pods
kubectl describe deployment app                      # imagem, sondas, limites, tolerations
POD=$(kubectl get pods -l app=web -o name | head -1) # guarda o nome do primeiro Pod
kubectl describe $POD                                # detalhe do Pod, com os Events no fim
for i in 1 2 3 4 5 6; do kubectl exec deploy/app -- wget -qO- http://app/; echo; done   # pedidos ao Service a partir de dentro do cluster
```

Port-forward (dois terminais):

```bash
kubectl port-forward service/app 8081:80   # Terminal 1: túnel para UM Pod (fica bloqueado)
curl -s http://localhost:8081/; echo       # Terminal 2: o hostname é sempre o mesmo
```

---

## 4. Ingress e balanceamento

```bash
kubectl get ingressclass                   # traefik
curl -i http://localhost:8080/             # 404: o Traefik responde mas ainda não tem regras
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
kubectl get configmap,secret,pvc           # o PVC fica em Pending (WaitForFirstConsumer)
kubectl get secret db -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 --decode; echo   # base64 não é cifra
kubectl apply -f k8s/db-deployment.yaml -f k8s/db-service.yaml   # Postgres fixo no nó servidor
kubectl rollout status deployment/db
kubectl get pvc,pv                         # o PVC passa a Bound
```

Editar `k8s/app-deployment.yaml` e acrescentar, a seguir a `APP_VERSION`:

```yaml
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef: { name: db, key: DATABASE_URL }
```

Em alternativa, copiar a solução: `cp k8s/solucao/app-deployment-s5.yaml k8s/app-deployment.yaml`.

```bash
kubectl diff -f k8s/app-deployment.yaml    # só aparece o bloco DATABASE_URL
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
docker tag cdn-pl02-app:1.0 cdn-pl02-app:1.1   # a mesma imagem com outra etiqueta
k3d image import cdn-pl02-app:1.1 -c cdn-pl02
```

Terminal 1 (tráfego contínuo, numa só linha):

```bash
while true; do curl -s -w ' %{http_code}\n' http://localhost:8080/ | sed -E 's/.*"version":"([^"]*)".*"hostname":"([^"]*)".* ([0-9]{3})$/\1 \2 \3/'; sleep 0.3; done | tee pedidos.txt
```

Terminal 2: editar `k8s/app-deployment.yaml` (`image: cdn-pl02-app:1.1` e `value: "1.1"`), ou `cp k8s/solucao/app-deployment-s6.yaml k8s/app-deployment.yaml`.

```bash
kubectl apply -f k8s/app-deployment.yaml
kubectl rollout status deployment/app
kubectl rollout history deployment/app     # revisões 1, 2 e 3
kubectl get replicaset                     # os antigos com DESIRED 0, o novo com 3
awk '{print $1, $3}' pedidos.txt | sort | uniq -c   # só códigos 200
```

Rollback:

```bash
kubectl rollout undo deployment/app        # volta à revisão anterior
kubectl rollout history deployment/app     # 1, 3, 4
kubectl get deployment app -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'   # cdn-pl02-app:1.0
cp k8s/solucao/app-deployment-s5.yaml k8s/app-deployment.yaml   # alinha o ficheiro com o cluster
```

Atualização falhada:

```bash
kubectl set image deployment/app app=cdn-pl02-app:9.9   # imagem que não existe
sleep 20
kubectl get pods                                        # o Pod novo fica em ImagePullBackOff, os antigos continuam Running
kubectl get events --field-selector reason=Failed       # causa: not found
kubectl rollout undo deployment/app
```

---

## 7. Falha de nó

Escolher um agente onde não esteja o Pod do Traefik:

```bash
kubectl get pods -n kube-system -o wide | grep '^traefik-'
NODE=k3d-cdn-pl02-agent-0       # definir em cada terminal que o usa (nesta execução o Traefik estava no agent-1)
```

Terminal 1:

```bash
while true; do curl -s --max-time 2 -w ' %{http_code}\n' http://localhost:8080/ | sed -E 's/.*"version":"([^"]*)".*"hostname":"([^"]*)".* ([0-9]{3})$/\1 \2 \3/'; sleep 0.5; done
```

Terminal 2:

```bash
kubectl get pods -o wide -w   # mostra as mudanças em tempo real
```

### 7.2 Saída ordenada

```bash
kubectl drain $NODE --ignore-daemonsets --delete-emptydir-data   # bloqueia o nó e expulsa os Pods
kubectl get nodes                       # Ready,SchedulingDisabled
kubectl uncordon $NODE                  # o nó volta a aceitar Pods
kubectl rollout restart deployment/app  # recria os Pods para voltarem a usar o nó
```

### 7.3 Falha abrupta

```bash
docker stop $NODE                       # desliga o nó sem aviso
kubectl get nodes                       # NotReady (~45 s)
kubectl describe node $NODE | grep -A3 Taints   # taints unreachable
kubectl get pods -o wide                # 30 s depois: o Pod antigo fica Terminating e aparece um novo noutro nó
```

### 7.4 Repor

```bash
docker start $NODE
sleep 20
kubectl get nodes                       # 3 nós Ready
kubectl get pods -o wide                # já sem Pods em Terminating
```

### 7.5 Limpeza

```bash
k3d cluster delete cdn-pl02                    # apaga o cluster, a rede, o volume e o contexto
docker rmi cdn-pl02-app:1.0 cdn-pl02-app:1.1   # apaga as imagens da app
rm -f pedidos.txt                              # ficheiro de tráfego da secção 6
git checkout -- k8s/app-deployment.yaml        # repõe o manifesto da ficha (desfaz as edições das secções 5 e 6)
docker ps -a | grep pl02                       # vazio
docker images | grep cdn-pl02                  # vazio
```

---

## Resultados obtidos (8 de outubro de 2026, execução a partir de `pl02/` do repositório)

| Secção | Medição | Resultado |
|---|---|---|
| 0 | Cluster de teste | criado em ~20 s e apagado; `rancher/k3s:v1.35.5-k3s1` e `k3d-proxy:5.9.0` já estavam em cache |
| 1 | `k3d cluster create cdn-pl02` | ~30 s; 3 nós `Ready`; 4 contentores `k3d-cdn-pl02-*`, com o `serverlb` em `8080->80`; contexto `k3d-cdn-pl02` |
| 2.1 | Apagar 1 dos 5 Pods `hello` | o ReplicaSet recria-o e continuam 5 |
| 2.2 | `diff` depois de editar | `-replicas: 2` / `+replicas: 4`; `apply` com 4/4 |
| 3 | Build e import | `cdn-pl02-app:1.0` com 62.9 MB; o `crictl images` do `agent-0` mostra-a |
| 3 | Pods da app | 1 por nó (server-0, agent-0, agent-1); 3 IPs no EndpointSlice |
| 3 | 6 pedidos via `kubectl exec` ao Service | passam pelos 3 Pods (distribuição aleatória: 1 / 1 / 4) |
| 3 | 3 pedidos via port-forward | sempre o mesmo Pod |
| 4 | Antes da regra / 30 pedidos pelo Ingress | `404` / 11, 10 e 9 por Pod |
| 5 | `/db` antes / depois do Secret | `DATABASE_URL is not set` / `{"status":"ok",...}` |
| 5 | Pod do Postgres | no `server-0` (nodeSelector); o PVC passa de `Pending` a `Bound` (1Gi, `local-path`) |
| 5 | `SELECT * FROM notas` depois de apagar o Pod | `sobrevive ao Pod`; o Pod novo ficou `Ready` em ~2 s |
| 6 | Rolling update 1.0 → 1.1 com tráfego | rollout em ~6 s; 39 pedidos: 27 × `1.0 200`, 12 × `1.1 200`, nenhum erro |
| 6 | Rollback | revisões 1, 3 e 4; imagem `cdn-pl02-app:1.0`; depois do `cp` do s5, `diff` sem diferenças |
| 6 | `cdn-pl02-app:9.9` | 1 Pod em `ImagePullBackOff` (`not found`), 3 antigos `Running`; a app respondeu sempre `200` |
| 7.2 | `drain` + `uncordon` + `rollout restart` com tráfego | 90 pedidos, todos `200`; depois do restart volta a haver 1 Pod por nó |
| 7.3 | `docker stop` do `agent-0` | `NotReady` ao fim de ~46 s; Pod substituto `Running` noutro nó aos ~80 s (30 s de tolerância contados a partir da perda de contacto) |
| 7.3 | Pedidos durante a falha (~1 m 30 s) | 113 pedidos: 96 × `200`, 17 × `000` (~15 %) |
| 7.4 | `docker start` | 3 nós `Ready` ao fim de 20 s; sem Pods em `Terminating` |
| 7.5 | Depois da limpeza | sem cluster, contentores, rede, volume, contexto ou imagens `cdn-pl02`; `app-deployment.yaml` reposto |

---

## Problemas encontrados

| Sintoma | Causa | Solução |
|---|---|---|
| Aviso de versões: kubectl v1.37 e k3s v1.35 | Diferença de duas versões, acima do que é suportado oficialmente | Sem impacto nesta ficha; ter atenção se algum comando falhar de forma estranha |
| `bash: syntax error near unexpected token 'newline'` | Comando corrido com `<nome-do-pod>` literal; `<` e `>` são redirecionamento | Substituir pelo nome real do Pod |
| `No resources found` ou poucos Pods logo depois de `create`/`apply` | O `get` correu antes de os Pods serem criados | Esperar uns segundos e repetir, ou usar `rollout status` |
| `Readiness probe failed: connection refused` nos Events de um Pod novo | A sonda correu antes de a app abrir a porta 3000 | Normal; o Pod fica `Ready` na sonda seguinte (5 s) |
| Pods antigos misturados com os novos, em `Completed`/`Terminating` | O Deployment anterior ainda está a ser removido | Ver a coluna `AGE` e repetir |
| Um `curl /db` com erro logo depois do rollout | O pedido caiu num Pod antigo em terminação | Repetir |
| `connect ECONNREFUSED` depois de apagar o Pod do Postgres | O Service ainda não tem o Pod novo como destino, e a app não volta a tentar | Repetir; em produção, retries com espera na app |
| Comando `while … sed` partido em duas linhas | Paginação do PDF | Colar numa só linha |
| Secção 6 sem `ImagePullBackOff` visível | O `get pods` correu antes de a descarga falhar | Acrescentar `sleep 20` |
| Erro `k8s/...: no such file` | Terminal fora de `pl02/` | Fazer `cd` para a pasta `pl02/` do repositório antes dos comandos com `k8s/` |
| Aviso `last-applied-configuration` no `rollout undo` | O `undo` muda o cluster mas não o ficheiro | Repor o ficheiro com `cp k8s/solucao/...` |
| `000` em cerca de 15 % dos pedidos durante o `docker stop` | O `serverlb` do k3d continua a enviar ligações para o nó parado | Desaparece quando o nó é reposto; em produção, health checks no load balancer |
| Cluster já existente a ocupar a 8080 (por exemplo, sobras da PL03) | Uma ficha anterior não foi limpa até ao fim | `k3d cluster list` e `k3d cluster delete <nome>` antes da secção 1 |
| Pods antigos ~30-40 s em `Terminating` depois de um rollout | A app não trata `SIGTERM`; o Kubernetes espera o `terminationGracePeriodSeconds` (30 s) e só então a mata | Esperar; não afeta os pedidos, porque o Pod já saiu do Service |
| `git status` mostra `k8s/app-deployment.yaml` alterado, `hello.yaml` ou `pedidos.txt` | A ficha corrida dentro do repositório edita o manifesto e cria ficheiros temporários | Na limpeza (7.5): `rm` dos temporários e `git checkout -- k8s/app-deployment.yaml` |
| `docker ps` mostra contentores que não são desta ficha (por exemplo `minikube`) | Outros projetos a usar o mesmo Docker Desktop | Os recursos desta ficha têm o prefixo `cdn-pl02`; filtrar com `docker ps --filter name=cdn-pl02` |

---

## Resumo da execução

| Ponto | O que foi feito | Resultado |
|---|---|---|
| 0. Preparação | Verificar o kubectl e o k3d; criar e apagar o cluster `cdn-pl02-teste` para ter as imagens em cache | ✅ Ferramentas e imagens prontas |
| 1. Cluster | `k3d cluster create cdn-pl02` com 1 servidor, 2 agentes e a porta 8080 no load balancer | ✅ 3 nós `Ready`, contexto `k3d-cdn-pl02` |
| 2. nginx | Deployment imperativo (scale, apagar um Pod) e declarativo (`hello.yaml`, `diff`, `apply`) | ✅ O ReplicaSet mantém as réplicas; o `apply` é idempotente |
| 3. App no cluster | Build de `cdn-pl02-app:1.0`, import, Deployment e Service; pedidos por `exec` e por port-forward | ✅ 3 Pods (1 por nó); o Service distribui, o port-forward fica num só Pod |
| 4. Ingress | Regra Traefik `/` → Service `app`; 30 pedidos | ✅ `404` → `200`; 11 / 10 / 9 por Pod |
| 5. Postgres | ConfigMap, Secret, PVC e Postgres; `DATABASE_URL` no Deployment; apagar o Pod do Postgres | ✅ `/db` `ok`; os dados sobrevivem no PVC |
| 6. Rolling update | 1.0 → 1.1 com tráfego, rollback, imagem inexistente `9.9` | ✅ 39 pedidos sem erros; rollback para `1.0`; o `9.9` não derruba a app |
| 7. Falha de nó | `drain`/`uncordon` com tráfego; `docker stop` e `start` do `agent-0` | ⚠️ A saída ordenada não perdeu nenhum pedido; a falha abrupta deu 15 % de `000` até o nó ser reposto |
| 7.5 Limpeza | Apagar o cluster e as imagens; repor `app-deployment.yaml` | ✅ Nada da PL02 fica no Docker; repositório limpo |
