# Nine Oils — Guia de Deploy
## Railway + Domínio Namecheap

---

## O QUE VAIS PRECISAR

- Conta GitHub (gratuita) → github.com
- Conta Railway (gratuita) → railway.app
- Acesso ao painel Namecheap da tua conta
- O ficheiro `server.js` e `package.json` deste zip

---

## PASSO 1 — Criar repositório no GitHub

1. Vai a **github.com** e faz login (ou cria conta)
2. Clica no **+** no canto superior direito → **New repository**
3. Dá o nome `nine-oils`
4. Deixa como **Private** (não precisas que seja público)
5. Clica **Create repository**
6. Na página seguinte, clica em **uploading an existing file**
7. Arrasta os ficheiros `server.js` e `package.json` para a área de upload
8. Clica **Commit changes**

✅ O teu código está agora no GitHub.

---

## PASSO 2 — Fazer deploy no Railway

1. Vai a **railway.app** e clica **Login with GitHub**
   - Autoriza o Railway a aceder à tua conta GitHub

2. Clica **New Project**

3. Escolhe **Deploy from GitHub repo**

4. Seleciona o repositório `nine-oils` que criaste

5. O Railway deteta automaticamente que é Node.js.
   - **Start command:** deve aparecer `node server.js` automaticamente
   - Se não aparecer, vai a **Settings → Deploy → Start Command** e escreve `node server.js`

6. Clica **Deploy** e aguarda 1-2 minutos

7. Quando aparecer **✅ Active**, clica em **Settings → Networking → Generate Domain**
   - O Railway gera um URL público tipo: `nine-oils-production.up.railway.app`
   - **Testa este URL no browser** — o jogo deve aparecer!

✅ O jogo está online. Agora vamos ligar ao teu domínio.

---

## PASSO 3 — Adicionar domínio personalizado no Railway

1. Ainda em **Settings → Networking**, clica **+ Add Custom Domain**
2. Escreve o subdomínio que queres usar, por exemplo:
   ```
   jogo.teusitio.com
   ```
3. O Railway mostra-te um valor CNAME, algo como:
   ```
   nine-oils-production.up.railway.app
   ```
   **Copia este valor** — vais precisar dele no passo seguinte.

---

## PASSO 4 — Configurar o subdomínio na Namecheap

1. Vai a **namecheap.com** → faz login → **Domain List**
2. Clica **Manage** no teu domínio
3. Vai ao separador **Advanced DNS**
4. Clica **Add New Record** e preenche assim:

   | Type  | Host | Value                                      | TTL       |
   |-------|------|--------------------------------------------|-----------|
   | CNAME | jogo | nine-oils-production.up.railway.app        | Automatic |

   *(substitui `jogo` pelo subdomínio que escolheste,*
   *e o Value pelo CNAME que o Railway te deu)*

5. Clica no **✔** para guardar

6. Aguarda 5 a 30 minutos para o DNS propagar
   - Podes verificar em **dnschecker.org** → escreve `jogo.teusitio.com`
   - Quando aparecer verde em todo o mundo, está pronto

---

## PASSO 5 — Confirmar HTTPS no Railway

1. Volta ao Railway → **Settings → Networking**
2. Ao lado do teu domínio personalizado deve aparecer **✅ SSL Active**
   - Se ainda estiver a processar, aguarda mais alguns minutos
3. O Railway trata do certificado SSL automaticamente — o jogo vai correr em `https://`

---

## PASSO 6 — Jogar!

- **Player 1** abre `https://jogo.teusitio.com`
- **Player 2** abre o mesmo URL no seu dispositivo
- O jogo começa automaticamente quando os dois estiverem ligados

---

## NOTAS IMPORTANTES

**Plano gratuito do Railway:**
- Inclui 500 horas de execução por mês (suficiente para uso casual)
- O servidor pode adormecer após inatividade — o primeiro jogador a abrir o URL acorda-o (demora ~10 segundos)
- Se quiseres que esteja sempre ativo, o plano pago custa $5/mês

**Se algo correr mal:**
- No Railway, clica em **Deployments → View Logs** para ver erros
- Garante que o `package.json` tem `"main": "server.js"`

---

## RESUMO RÁPIDO

```
GitHub  → upload server.js + package.json
Railway → deploy from GitHub → gera URL → add custom domain → copia CNAME
Namecheap → Advanced DNS → add CNAME record → aguarda propagação
Jogar → https://jogo.teusitio.com
```

---

*Nine Oils — a game of luck and will by David Marques*
