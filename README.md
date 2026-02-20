# Nine Oils

**A game of luck and will** · by David Marques · v1.4

A two-player web-based dice game set in the 1861 snake oil trade. Race to stock six bottles in your market stall before your opponent does.

---

## Setup & Running

```bash
node server.js
```

Requires Node.js 18+. No dependencies. Open `http://localhost:3000` in a browser.

For multiplayer, deploy to any Node.js host (Railway, Render, Fly.io). The server handles WebSocket connections automatically.

---

---

# RULES — English Edition

## Background

In 1861, the snake oil trade thrived — and you are embarking on a venture at the heart of this intriguing business. You plan to establish a market stall to promote and sell your own snake oil brand. As your business flourishes, you'll need to expand your stall, replenish your stock, and persuade influential figures to gain dominance over your rivals.

**Your ultimate goal:** be the first vendor to stock all six bottles in your stall.

## Components

- 2 Stall cards (6 slots each, 2 blocked by red cubes at start)
- 9 dice
- 8 Character cards (2× Temptress, 2× Boy, 4× Bully)
- Snake Oil bottle tokens

## Setup

1. Each player takes one Stall card. Place 2 red cubes on slots 1 and 2 — these slots are locked until unlocked by a Quad or Eight of a Kind.
2. Shuffle the 8 Character cards and place face-down in the centre as the deck.
3. Each player draws 1 card from the deck.
4. Randomly determine who goes first.

## Win Condition

First player to stock all **6 bottle slots** in their stall wins. A slot must be unlocked (no red cube) before it can receive a bottle.

---

## Turn Structure

Each turn has up to 4 steps:

1. **Play Cards** *(optional)* — play any Character cards from your hand before rolling.
2. **Roll** — roll all 9 dice.
3. **Resolve Combos** — apply all eligible combos from your roll.
4. **Discard** — if you hold more than 3 cards, discard down to 3.

---

## Dice Combos

> **Core rule:** each face value produces **only one combo** per roll. If the same face qualifies for multiple combos, you must choose one. The remaining dice of that face are discarded — no cascading.

### Standard Combos

| Dice | Combo | Effect |
|---|---|---|
| Any 2 matching | **DOUBLE** | Draw 1 Character card from the deck |
| 3 of one value + 2 of another | **TRIPLE + DOUBLE** | Stock 1 bottle in your stall |
| 4 of the same value | **QUAD** | Remove 1 red cube, unlocking a stall slot |
| 5 of the same value | **PENTA** | Opponent discards their entire hand |
| 6 of the same value | **SIX** | Draw 3 Character cards from the deck |

> **Triple + Double rule:** the pair must come from a *different* face value than the triple. A pair of the same face as the triple does not count.

> **Multiple combos:** if you roll, for example, four 3s and three 5s — you have a conflict between QUAD (four 3s) and TRIPLE+DOUBLE (three 5s + two of the 3s). You must choose one.

### Special Combos

| Dice | Combo | Effect |
|---|---|---|
| 7 of the same value | **✦ JOKER** | Choose any previous combo (Double through Six) |
| 8 of the same value | **✦ EIGHT OF A KIND** | Remove 2 red cubes instantly |
| All 9 the same | **✦ NINE OF A KIND** | Instant victory |

> **Joker note:** when you use the Joker to select Triple+Double, the pair does *not* need to be a different face value — all 7 dice count.

### Combo Probabilities (9 dice, 6-sided)

| Combo | Approx. frequency |
|---|---|
| Double | Every roll |
| Triple+Double | ~82% of rolls |
| Quad | ~28% of rolls |
| Penta | ~5% of rolls (1 in 19) |
| Six of a Kind | 1 in ~160 rolls |
| Joker (7) | 1 in ~1,900 rolls |
| Eight of a Kind | 1 in ~40,000 rolls |
| Nine of a Kind | 1 in ~1,700,000 rolls |

---

## Character Cards

Cards are played at the **start of your turn**, before rolling. You may play any number of cards. Cards are discarded after use unless stated otherwise.

### 💃 The Temptress *(×2)*

Play before rolling. When you roll a Triple+Double, gain **1 additional bottle** (2 total). Playing both Temptress cards grants 2 extra bottles (3 total).

### 🤏 The Boy *(×2)*

Play on your turn to **steal 1 bottle** from your opponent's stall. Each Boy card is one steal attempt.

| Scenario | Result |
|---|---|
| 1 Boy, no Bullies defended | Steal 1 bottle |
| 1 Boy vs. 1 Bully | Theft fully blocked |
| 2 Boys vs. 1 Bully | 1 stolen, 1 blocked |
| 2 Boys vs. 0 Bullies | 2 stolen |

The defender chooses how many Bullies to play (up to the number of Boys attacking). Playing 2 Boys simultaneously (before the defender responds) is unblockable by a single Bully.

### 👊 The Bully *(×4)*

**Defensive use:** play on your *opponent's* turn to cancel one Boy attack. Both cards (Boy + Bully) are discarded.

**Offensive use:** play **2 Bullies** on *your own* turn — blindly discard 1 card from your opponent's hand.

---

## Hand Limit

You may never hold more than **3 Character cards** at the end of your turn. If you exceed this, discard down to 3 before the turn ends. There is no minimum hand size.

---

## Quick Reference

```
2 matching          →  Double — draw a card
3+2 (diff. faces)  →  Triple+Double — stock a bottle
4 matching          →  Quad — unlock a stall slot
5 matching          →  Penta — opponent discards hand
6 matching          →  Six — draw 3 cards
7 matching          →  Joker — choose any previous combo
8 matching          →  Eight of a Kind — remove 2 cubes
9 matching          →  Instant Win
```

---

---

# REGRAS — Edição Portuguesa

## Contexto

Em 1861, o comércio do óleo de cobra estava no seu auge — e tu estás prestes a embarcar numa aventura no coração deste negócio intrigante. Planeias estabelecer uma banca no mercado para promover e vender a tua própria marca de óleo de cobra. À medida que o teu negócio prospera, terás de expandir a banca, reabastecer o stock e persuadir figuras influentes para ganhar vantagem sobre os teus rivais.

**Objectivo:** sê o primeiro vendedor a colocar todas as seis garrafas na tua banca.

## Componentes

- 2 cartas de Banca (6 casas cada, 2 bloqueadas por cubos vermelhos no início)
- 9 dados
- 8 cartas de Personagem (2× Sedutora, 2× Rapaz, 4× Valentão)
- Fichas de garrafas de Óleo de Cobra

## Preparação

1. Cada jogador recebe uma carta de Banca. Coloca 2 cubos vermelhos nas casas 1 e 2 — estas casas estão bloqueadas até serem abertas por um Quad ou Oito de um Tipo.
2. Baralha as 8 cartas de Personagem e coloca-as viradas para baixo no centro como o baralho.
3. Cada jogador compra 1 carta do baralho.
4. Decide aleatoriamente quem começa.

## Condição de Vitória

O primeiro jogador a colocar garrafas em todas as **6 casas** da sua banca vence. Uma casa tem de estar desbloqueada (sem cubo vermelho) antes de poder receber uma garrafa.

---

## Estrutura do Turno

Cada turno tem até 4 passos:

1. **Jogar Cartas** *(opcional)* — joga cartas de Personagem da tua mão antes de lançar os dados.
2. **Lançar** — lança todos os 9 dados.
3. **Resolver Combinações** — aplica todas as combinações elegíveis do teu lançamento.
4. **Descartar** — se tiveres mais de 3 cartas, descarta até ficares com 3.

---

## Combinações de Dados

> **Regra fundamental:** cada valor de face produz **apenas uma combinação** por lançamento. Se a mesma face se qualificar para múltiplas combinações, tens de escolher uma. Os dados restantes dessa face são descartados — sem cascata.

### Combinações Normais

| Dados | Combinação | Efeito |
|---|---|---|
| Quaisquer 2 iguais | **DOUBLE** | Compra 1 carta de Personagem do baralho |
| 3 de um valor + 2 de outro | **TRIPLE + DOUBLE** | Coloca 1 garrafa na tua banca |
| 4 do mesmo valor | **QUAD** | Remove 1 cubo vermelho, desbloqueando uma casa |
| 5 do mesmo valor | **PENTA** | O adversário descarta toda a mão |
| 6 do mesmo valor | **SEIS** | Compra 3 cartas de Personagem do baralho |

> **Regra do Triple + Double:** o par tem de vir de um valor de face *diferente* do trio. Um par do mesmo valor que o trio não conta.

> **Conflito de combinações:** se lançares, por exemplo, quatro 3s e três 5s — tens um conflito entre QUAD (quatro 3s) e TRIPLE+DOUBLE (três 5s + dois dos 3s). Tens de escolher uma.

### Combinações Especiais

| Dados | Combinação | Efeito |
|---|---|---|
| 7 do mesmo valor | **✦ JOKER** | Escolhe qualquer combinação anterior (de Double a Seis) |
| 8 do mesmo valor | **✦ OITO DE UM TIPO** | Remove 2 cubos vermelhos instantaneamente |
| Todos 9 iguais | **✦ NOVE DE UM TIPO** | Vitória instantânea |

> **Nota sobre o Joker:** ao usares o Joker para seleccionar Triple+Double, o par *não* precisa de ser de um valor de face diferente — todos os 7 dados contam.

### Probabilidades das Combinações (9 dados, 6 faces)

| Combinação | Frequência aproximada |
|---|---|
| Double | Em todos os lançamentos |
| Triple+Double | ~82% dos lançamentos |
| Quad | ~28% dos lançamentos |
| Penta | ~5% dos lançamentos (1 em 19) |
| Seis de um Tipo | 1 em ~160 lançamentos |
| Joker (7) | 1 em ~1.900 lançamentos |
| Oito de um Tipo | 1 em ~40.000 lançamentos |
| Nove de um Tipo | 1 em ~1.700.000 lançamentos |

---

## Cartas de Personagem

As cartas jogam-se no **início do teu turno**, antes de lançar os dados. Podes jogar qualquer número de cartas. As cartas são descartadas após uso, salvo indicação contrária.

### 💃 A Sedutora *(×2)*

Joga antes de lançar. Quando lançares um Triple+Double, ganha **1 garrafa adicional** (2 no total). Jogar ambas as cartas de Sedutora concede 2 garrafas extra (3 no total).

### 🤏 O Rapaz *(×2)*

Joga no teu turno para **roubar 1 garrafa** da banca do adversário. Cada carta de Rapaz é uma tentativa de roubo.

| Cenário | Resultado |
|---|---|
| 1 Rapaz, sem Valentões | Roubar 1 garrafa |
| 1 Rapaz vs. 1 Valentão | Roubo totalmente bloqueado |
| 2 Rapazes vs. 1 Valentão | 1 roubada, 1 bloqueada |
| 2 Rapazes vs. 0 Valentões | 2 roubadas |

O defensor escolhe quantos Valentões jogar (até ao número de Rapazes em ataque). Jogar 2 Rapazes em simultâneo (antes da resposta do defensor) é inbloqueável por um único Valentão.

### 👊 O Valentão *(×4)*

**Uso defensivo:** joga no turno do *adversário* para cancelar um ataque de Rapaz. Ambas as cartas (Rapaz + Valentão) são descartadas.

**Uso ofensivo:** joga **2 Valentões** no *teu próprio* turno — descarta às cegas 1 carta da mão do adversário.

---

## Limite de Mão

Nunca podes ter mais de **3 cartas de Personagem** no final do teu turno. Se ultrapassares este limite, descarta até ficares com 3. Não existe mínimo de cartas na mão.

---

## Referência Rápida

```
2 iguais             →  Double — compra uma carta
3+2 (faces dif.)    →  Triple+Double — coloca uma garrafa
4 iguais             →  Quad — desbloqueia uma casa
5 iguais             →  Penta — adversário descarta a mão
6 iguais             →  Seis — compra 3 cartas
7 iguais             →  Joker — escolhe qualquer combinação anterior
8 iguais             →  Oito de um Tipo — remove 2 cubos
9 iguais             →  Vitória Instantânea
```

---

*Nine Oils — Game design & development · David Marques · 2025*
