# T05 · Dados distribuídos

**MEI · Computação Distribuída e em Nuvem** · 14 de outubro de 2026
Ricardo Costa · rcosta@estg.ipp.pt

---

## Índice

1. [Ponto de partida](#1-ponto-de-partida)
2. [Replicar e particionar](#2-replicar-e-particionar)
3. [Consistência](#3-consistência)
4. [Quóruns](#4-quóruns)
5. [CAP e PACELC](#5-cap-e-pacelc)
6. [Dados na cloud e no cluster](#6-dados-na-cloud-e-no-cluster)
7. [Cache](#7-cache)
8. [O caso do stock](#8-o-caso-do-stock)
9. [Resumo e ponte para a T06](#9-resumo-e-ponte-para-a-t06)
10. [Ligação ao PL04](#10-ligação-ao-pl04)
11. [Fontes](#11-fontes)

---

## 1. Ponto de partida

A T04 terminou com uma pergunta: **com várias cópias dos dados, como se mantêm consistentes?**

Na aplicação do laboratório, o `tickets` guarda o stock em dois sítios:

```
              ┌──────────────┐
              │   tickets    │
              └──────┬───────┘
          ┌──────────┴──────────┐
          ▼                     ▼
   ┌─────────────┐       ┌─────────────┐
   │  Postgres   │       │    Redis    │
   │ sold = 999  │       │ stock = 1   │
   └─────────────┘       └─────────────┘
        mesmo facto, duas cópias
```

> **Pergunta à turma:** dois clientes leem "resta 1 bilhete" em duas cópias diferentes. Quem fica com ele?

---

## 2. Replicar e particionar

### 2.1 Os dois conceitos

| | Replicar | Particionar (sharding) |
|---|---|---|
| **O que faz** | Mesmos dados em vários nós | Dados diferentes em nós diferentes |
| **Para quê** | Fiabilidade e desempenho | Escala |
| **Custo** | Manter as cópias iguais | Repartir bem a carga |

```
 REPLICAR                         PARTICIONAR
 ┌─────┐ ┌─────┐ ┌─────┐          ┌─────┐ ┌─────┐ ┌─────┐
 │A B C│ │A B C│ │A B C│          │  A  │ │  B  │ │  C  │
 └─────┘ └─────┘ └─────┘          └─────┘ └─────┘ └─────┘
  nó 1    nó 2    nó 3             nó 1    nó 2    nó 3
```

O custo central da replicação: quando uma cópia muda, todas têm de mudar. As réplicas têm de se manter **consistentes**.

### 2.2 Três modelos de replicação

| | Primário-secundário | Multi-líder | Sem líder |
|---|---|---|---|
| **Quem aceita escritas** | Só o primário | Vários nós | Vários nós (escrita e leitura a vários) |
| **Propagação** | Primário → secundários | Os líderes trocam escritas entre si | Réplicas divergentes reconciliam-se depois |
| **Leituras** | Secundários podem servir leituras | Qualquer líder | Consulta R réplicas |
| **Problema típico** | Atraso das réplicas | Conflitos em escritas concorrentes | Versões divergentes |
| **Exemplo** | Postgres | Resolução por utilizador ou regras | Dynamo (parâmetros R e W) |

```
 PRIMÁRIO-SECUNDÁRIO     MULTI-LÍDER           SEM LÍDER
     escrita               escrita  escrita       escrita
        │                     │       │          ┌──┼──┐
        ▼                     ▼       ▼          ▼  ▼  ▼
   ┌─────────┐            ┌─────┐◄─►┌─────┐    ┌─┐ ┌─┐ ┌─┐
   │primário │            │ L1  │   │ L2  │    │A│ │B│ │C│
   └────┬────┘            └─────┘   └─────┘    └─┘ └─┘ └─┘
     ┌──┴──┐
     ▼     ▼
   ┌───┐ ┌───┐
   │ S1│ │ S2│
   └───┘ └───┘
```

### 2.3 Replicação síncrona e assíncrona

```
 SÍNCRONA                              ASSÍNCRONA
 Cliente  Primário  Réplica            Cliente  Primário  Réplica
   │──escrita─►│        │                │──escrita─►│        │
   │           │──WAL──►│                │◄───OK─────│        │
   │           │◄──ack──│                │           │──WAL──►│ (depois)
   │◄───OK─────│        │
```

| | Síncrona | Assíncrona |
|---|---|---|
| **Confirmação** | Depois de o secundário gravar | Logo no primário |
| **Latência** | Cada escrita espera um round-trip | Baixa |
| **Leituras na réplica** | Atuais | Podem ser antigas (*stale*) |
| **No failover** | Não perde dados | Pode perder escritas já confirmadas |

**Atraso de replicação (replication lag):** tempo até a escrita ser visível na réplica.

**Failover:** um secundário é promovido a primário. Em assíncrona, a perda de dados é proporcional ao atraso no momento da falha.

### 2.4 Particionamento por intervalo e por hash

| | Por intervalo (range) | Por hash |
|---|---|---|
| **Como escolhe a partição** | Intervalo contínuo de chaves | Hash da chave |
| **Vantagem** | Consultas por intervalo eficientes | Distribuição mais uniforme |
| **Risco** | Hot spot com chaves crescentes (datas, IDs sequenciais) | Consultas por intervalo vão a todas as partições |

```
 POR INTERVALO (chave = data)              POR HASH
 ┌────────┐ ┌────────┐ ┌────────┐          ┌────────┐ ┌────────┐ ┌────────┐
 │ jan-abr│ │ mai-ago│ │set-dez │          │  ~33%  │ │  ~33%  │ │  ~33%  │
 │   ░    │ │   ░    │ │ ██████ │◄ escritas└────────┘ └────────┘ └────────┘
 └────────┘ └────────┘ └────────┘ novas
                        HOT SPOT
```

**Hot spot:** partição com muito mais carga do que as outras. Particionar só dá escala se a carga se repartir.

### 2.5 Hashing consistente

**O problema do `hash mod N`:** passar de 3 para 4 nós muda 75 % das chaves de nó.

**A solução:** o espaço de hash é um **anel**. Cada chave pertence ao primeiro nó que encontra ao andar no sentido do anel.

```
                 Nó A
              ●──────────●
           ╱    k1 → B     ╲
       Nó D ●               ● Nó B
           ╲    k2 → C     ╱
              ●──────────●
                 Nó C

 Entra um nó novo (E) entre A e B:
 só as chaves entre A e E mudam de nó.
 Os outros nós não são afetados.
```

| Vantagem | Limite | Solução do Dynamo |
|---|---|---|
| Entrada ou saída de um nó só afeta os vizinhos | Posições aleatórias dão carga desigual | Nós virtuais; cada chave fica em N nós seguidos no anel |

---

## 3. Consistência

### 3.1 Forte e eventual

| | Forte (linearizabilidade) | Eventual |
|---|---|---|
| **Definição** | Cada operação parece acontecer num instante entre o início e o fim | Sem novas escritas, as réplicas acabam iguais |
| **Leitura após escrita concluída** | Devolve esse valor ou um mais recente | Pode devolver o valor antigo |
| **Exemplo** | Após vender o último bilhete, qualquer leitura diz "esgotado" | DynamoDB: leitura pode não refletir escrita recente; repetida, acaba por refletir |
| **Custo** | Coordenação, menos escalabilidade | Leituras desatualizadas |

```
 Espectro de consistência
 ◄──────────────────────────────────────────────►
 FORTE                                      EVENTUAL
 mais coordenação                    menos coordenação
 mais latência                           mais escala
```

### 3.2 Consistência centrada no cliente

Garantias **por cliente** (ou sessão) sobre dados com consistência fraca.

| Garantia | O que promete |
|---|---|
| **Read-your-writes** | O processo vê sempre as suas próprias escritas |
| **Monotonic reads** | Leituras seguintes nunca devolvem valores mais antigos |

**Caso real (Terry et al.):** o utilizador muda a palavra-passe, escreve a nova e recebe "palavra-passe inválida". O servidor contactado ainda não a tinha.

### 3.3 Escrevo no primário, leio da réplica

```
            2 · replicação assíncrona (com atraso)
  ┌──────────────┐  ─────────────────────►  ┌──────────────┐
  │   PRIMÁRIO   │                          │   RÉPLICA    │
  │  stock = 0   │                          │  stock = 1   │
  │  (aplicada)  │                          │ (ainda não)  │
  └──────▲───────┘                          └──────┬───────┘
         │ 1 · escreve stock = 0                   │ 3 · lê stock = 1
         │     (confirmada)                        │     (valor antigo)
         │            ┌──────────┐                 │
         └────────────│ CLIENTE  │◄────────────────┘
                      └──────────┘
```

**Resultado:** viola read-your-writes. Com duas réplicas, pode violar também monotonic reads.

**Saídas:**
- Ler do primário depois de escrever.
- Esperar que a réplica aplique a escrita. No Postgres: réplica em `synchronous_standby_names` e `synchronous_commit = remote_apply`.

---

## 4. Quóruns

### 4.1 N, R e W

| Parâmetro | Significado |
|---|---|
| **N** | Número de réplicas do item |
| **W** | Réplicas que têm de aceitar a escrita |
| **R** | Réplicas consultadas na leitura |

**Regras:**
- `R + W > N` → leitura e escrita intersetam-se (evita conflitos leitura-escrita).
- `W > N/2` → evita conflitos escrita-escrita.

**Configuração usual no Dynamo:** `(N, R, W) = (3, 2, 2)`. A latência é ditada pela réplica mais lenta das R (ou W), por isso R e W costumam ser menores do que N.

```
 N = 3, W = 2, R = 2   →   R + W = 4 > 3

  Escrita v2 (W = 2)
  ┌────┴────┐
  ▼         ▼
 ┌────┐   ┌────┐   ┌────┐
 │ A  │   │ B  │   │ C  │
 │ v2 │   │ v2 │   │ v1 │
 └────┘   └────┘   └────┘
            ▲         ▲
            └────┬────┘
           Leitura (R = 2)
     B está na interseção → devolve v2
```

### 4.2 O que garantem e o que não garantem

| Garantem | Não garantem |
|---|---|
| Com `R + W > N` e quórum estrito, em condições normais a leitura vê a última escrita confirmada (se a identificar como a mais recente) | Linearizabilidade por si só |
| | Interseção com **quórum relaxado** (*sloppy quorum*): em falhas usam-se os primeiros N nós saudáveis |
| | Escritas concorrentes sem conflito: ficam versões divergentes a reconciliar |
| | *Last write wins* com relógios pode descartar escritas |

---

## 5. CAP e PACELC

### 5.1 Teorema CAP, com rigor

**Gilbert & Lynch (2002):** numa rede assíncrona, é impossível garantir disponibilidade e consistência linearizável em todas as execuções, incluindo as que perdem mensagens.

Três pontos essenciais:
- Só **durante uma partição** se escolhe entre C e A.
- "Escolher 2 de 3" é enganador (Brewer, 2012). P não é opcional numa rede real. Sem partição, tem-se C e A.
- O **C do CAP não é o C do ACID.** O do ACID refere-se a transações. O do CAP a uma operação pedido-resposta.

```
                 PARTIÇÃO DE REDE
   ┌─────────────┐      ║      ┌─────────────┐
   │    Nó 1     │      ║      │    Nó 2     │
   │ stock = 0   │   ✕  ║  ✕   │ stock = 1   │
   │  (escrita)  │      ║      │  (leitura)  │
   └─────────────┘      ║      └─────────────┘

   Escolher C → o nó 2 recusa responder (indisponível)
   Escolher A → o nó 2 responde stock = 1 (valor antigo)
```

### 5.2 PACELC: e sem partição?

**Abadi (2012):**

```
 Há partição (P)?
    │
    ├── SIM → escolher entre  A (disponibilidade)  e  C (consistência)
    │
    └── NÃO (Else) → escolher entre  L (latência)  e  C (consistência)
```

O CAP só fala de falhas. Em operação normal, o custo da consistência é a **latência**. A parte ELC só se aplica a sistemas que replicam dados.

| Sistema | Com partição | Sem partição | Classificação |
|---|---|---|---|
| Dynamo, Cassandra, Riak (por omissão) | A | L | **PA/EL** |
| PNUTS | C | L | **PC/EL** |

**Ligação à replicação (2.3):** síncrona escolhe consistência e paga latência. Assíncrona escolhe latência e aceita leituras antigas.

---

## 6. Dados na cloud e no cluster

### 6.1 Bloco, ficheiro e objeto

| | Bloco | Ficheiro | Objeto |
|---|---|---|---|
| **Serviço AWS** | EBS | EFS | S3 |
| **Como se usa** | Como um disco local ligado à instância | Sistema de ficheiros hierárquico partilhado (NFS) | Objetos num espaço plano, por chave e API |
| **Partilha** | Uma instância | Vários clientes | Vários clientes |
| **Replicação** | Vários servidores dentro de uma zona de disponibilidade | Gerida pela AWS | Gerida pela AWS |
| **Concorrência** | — | — | Escrita numa chave é atómica; ganha o pedido com timestamp mais recente |

As três replicam internamente. Muda a interface e as garantias que o programador vê.

### 6.2 Bases de dados geridas

| Serviço | Consistência |
|---|---|
| **DynamoDB** | Eventual por omissão; forte com `ConsistentRead = true` |
| **S3** | Leitura-após-escrita forte para PUT e DELETE, desde 1/12/2020 |
| **RDS (réplica de leitura)** | Assíncrona; pode estar desatualizada (como em 3.3) |

> **Atenção:** ler com consistência forte **não** torna atómico "verificar e agir". O item pode ser alterado logo a seguir à leitura.

### 6.3 StatefulSet e volumes persistentes

| | Deployment (T03) | StatefulSet |
|---|---|---|
| **Pods** | Intercambiáveis, efémeros | Identidade fixa |
| **Nomes** | Aleatórios (`postgres-7978…`) | Ordinais (`postgres-0`, `postgres-1`) |
| **Rede** | Nome partilhado | Nome DNS por Pod (`postgres-0.postgres`) |
| **Armazenamento** | Partilhado ou nenhum | Um PVC por réplica (`volumeClaimTemplates`) |

```
  StatefulSet "postgres"
  ┌──────────────┐     ┌──────────────┐
  │  postgres-0  │     │  postgres-1  │
  └──────┬───────┘     └──────┬───────┘
         │                    │
  ┌──────▼───────┐     ┌──────▼───────┐
  │data-postgres-│     │data-postgres-│
  │      0       │     │      1       │
  └──────────────┘     └──────────────┘
   PVC sobrevive ao Pod e volta a ligar-se ao mesmo
```

**Limites:**
- O StatefulSet **não replica dados**. Cada réplica tem o seu volume.
- Volumes locais dependem do nó. Se o nó falha, o Pod não consegue correr.

---

## 7. Cache

### 7.1 Cache-aside

```
           1 · lê
 ┌─────────┐ ───────► ┌─────────┐
 │Aplicação│          │  Cache  │
 └────┬────┘ ◄─────── └─────────┘
      │      hit: devolve     ▲
      │                       │ 3 · grava na cache
      │ 2 · miss: lê da BD    │
      ▼                       │
 ┌─────────┐ ─────────────────┘
 │   BD    │
 └─────────┘
```

| Conceito | Significado |
|---|---|
| **Cache-aside** | Lê da cache; em miss, lê da BD e grava na cache |
| **TTL** | Tempo de vida da entrada; ao expirar, volta à BD |
| **Invalidação** | Na escrita, apaga a entrada; a leitura seguinte repovoa |
| **Problema** | Não garante consistência: entre escrita e leitura há dados antigos |

### 7.2 Cache vazia vs. cache antiga

| Cache volta… | Efeito |
|---|---|
| **Vazia** | Gera misses. Vai à BD. Valores certos. |
| **Com dados antigos** (ex.: snapshot RDB do Redis) | Responde com valores errados. Ninguém corrige. |

> **Cache antiga é pior do que cache vazia.** A fonte de verdade tem de ser uma só.

---

## 8. O caso do stock

### 8.1 Verificar e agir: a corrida

```
 NAIVE (verificar e agir)                DB-ATOMIC (operação atómica)

 Pedido A: lê stock = 1 → há stock       Pedido A: UPDATE condicional
 Pedido B: lê stock = 1 → há stock                 → 1 linha afetada → vendido
 Pedido A: grava venda (sold + 1)        Pedido B: UPDATE condicional
 Pedido B: grava venda (sold + 1)                  → 0 linhas afetadas → esgotado

 Resultado: 2 vendidos, 1 bilhete        Resultado: 1 vendido, 1 esgotado
            SOBREVENDA                              CORRETO
```

**Mais réplicas do serviço não resolvem.** Cada réplica pode ler o mesmo valor antes de qualquer escrita.

**Porque funciona o `db-atomic`:** o `UPDATE … WHERE sold + qty <= capacity` serializa por linha. Se outra transação alterou a linha, o Postgres reavalia o `WHERE` sobre a versão nova (Read Committed).

### 8.2 Ponto de serialização e fonte de verdade

| Conceito | Definição | No laboratório |
|---|---|---|
| **Ponto de serialização** | Um só sítio decide, uma operação de cada vez sobre o mesmo item | `UPDATE` condicional no Postgres, ou script Lua no Redis |
| **Árbitro** | Quem decide se há stock | Postgres ou Redis |
| **Fonte de verdade** | Onde a venda passa a existir | **Sempre o Postgres** |

### 8.3 Medição no laboratório (capacidade 1000)

| Redis reinicia… | Contador | Vendas em excesso |
|---|---|---|
| **Vazio** | Reconstruído a partir do Postgres | **0** |
| **Com estado antigo** (snapshot) | Ninguém o corrige | **300** |

> **Pergunta à turma:** o Redis diz que há stock e o Postgres diz que não. Em quem se confia, e como se evita vender a mais?

---

## 9. Resumo e ponte para a T06

| Tema | Ideia-chave |
|---|---|
| **Replicação** | Dá fiabilidade e desempenho. Custa consistência. |
| **Síncrona vs. assíncrona** | Síncrona paga latência. Assíncrona pode perder escritas no failover. |
| **Particionamento** | Dá escala: intervalo, hash, hashing consistente. |
| **Consistência** | É um espectro: forte, eventual, read-your-writes, monotonic reads. |
| **Quóruns** | `R + W > N` dá interseção, não linearizabilidade. |
| **CAP** | Só durante partição se escolhe entre C e A. |
| **PACELC** | Sem partição, escolhe-se entre latência e consistência. |
| **Réplicas e caches** | São cópias. A fonte de verdade é uma só. |
| **Stock** | Um ponto de serialização impede vender o mesmo bilhete duas vezes. |

**T06:** quando as peças falham. Tolerância a faltas, autoscaling e observabilidade.

---

## 10. Ligação ao PL04

| Conceito da T05 | Secção do PL04 |
|---|---|
| StatefulSet e PVC (6.3) | 1. Postgres como StatefulSet |
| Limites do volume local (6.3) | 2. Parar o nó do Postgres |
| Replicação assíncrona e read-your-writes (2.3, 3.3) | 3. Réplica de leitura |
| Verificar e agir, ponto de serialização (8.1, 8.2) | 4. naive, db-atomic, redis-atomic |
| Cache antiga vs. vazia, fonte de verdade (7.2, 8.3) | 5. Desafio Redis |

---

## 11. Fontes

- Tanenbaum & Van Steen, *Distributed Systems*, 4.ª ed., cap. 7 (Consistency and replication).
- DeCandia et al., "Dynamo: Amazon's highly available key-value store", SOSP 2007, §4.2–4.6 e §6.
- Gilbert & Lynch, ACM SIGACT News 33(2), 2002.
- Brewer, "CAP twelve years later", IEEE Computer 45(2), 2012.
- Abadi, "Consistency tradeoffs in modern distributed database system design", IEEE Computer 45(2), 2012.
- Terry et al., "Session guarantees for weakly consistent replicated data", PDIS 1994.
- PostgreSQL 18, cap. 13 (Concurrency Control) e cap. 26 (High Availability, Load Balancing, and Replication).
- MongoDB Manual, Ranged Sharding e Hashed Sharding.
- Kleppmann, *Designing Data-Intensive Applications*, cap. 6 (leitura de apoio).
- AWS: guias do EBS, EFS, S3, DynamoDB, RDS e ElastiCache.
- Microsoft Learn, Cache-Aside pattern.
- Redis, Persistence.
- kubernetes.io: StatefulSets, Persistent Volumes, Volumes (local).
