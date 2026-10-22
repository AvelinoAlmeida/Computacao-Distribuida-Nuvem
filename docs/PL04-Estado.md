# PL04 · Estado no cluster

**MEI · Computação Distribuída e em Nuvem** · 14 de outubro de 2026
Ricardo Costa · rcosta@estg.ipp.pt · Gabinete 1.3

> **Adaptação pessoal:** pasta de trabalho `~/cdn/pl04` (no guia original: `~/pl04`).
> Shell: bash do terminal Ubuntu do WSL2. Editor: VS Code.

---

## Índice

1. [Objetivos](#1-objetivos)
2. [Pré-requisitos e regras do guia](#2-pré-requisitos-e-regras-do-guia)

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
| Pasta na home Linux: `~/cdn/pl04` | Nunca em `C:\...` nem em `/mnt/c/...` |
| Comandos com `\` no fim da linha | Copiar o bloco inteiro |
| Texto entre `<…>` | Substituir pelo valor real, sem `<` e `>` |
| Todos os comandos correm a partir de `~/cdn/pl04` | Os caminhos `k8s/`, `k6/` são relativos |

### 2.4 Como o guia está organizado

```
 Secção 0 ─► Secção 1 ─► Secção 2 ─► Secção 3 ─► Secção 4 ─► Secção 5
                     cada uma termina com
                 ✅ Verificação  +  Resolução de problemas
```

Um passo falha? Lê a caixa de resolução de problemas dessa secção. Persiste? Chama o docente ou trabalha em par.
