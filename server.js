// ═══════════════════════════════════════════════════════════
//  NINE OILS — V2: MOBILE + SOLO + METRICS
// ═══════════════════════════════════════════════════════════
const http    = require('http');
const { WebSocketServer } = require('ws');
const { networkInterfaces } = require('os');

const PORT        = process.env.PORT || 3000;
const MAX_LOBBIES = 5;
const INITIAL_DECK = ['TEMPTRESS','TEMPTRESS','BOY','BOY','BULLY','BULLY','BULLY','BULLY'];

// ─── STATE ──────────────────────────────────────────────
const lobbies = {};
const wsState = new WeakMap();
// sessionToken -> {lobbyId, seat, name} — survives WS disconnects
const sessions = {};
const GRACE_MS  = 45000; // ms before a disconnected seat is cleared

function uid() { return Math.random().toString(36).slice(2,8).toUpperCase(); }
function shuffle(a) {
  const r=[...a];
  for(let i=r.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[r[i],r[j]]=[r[j],r[i]];}
  return r;
}
function sendTo(ws,msg){ if(ws&&ws.readyState===1) ws.send(JSON.stringify(msg)); }
function lobbyList(){
  return Object.values(lobbies)
    .sort((a,b)=>{
      if(a.solo&&!b.solo)return -1;
      if(!a.solo&&b.solo)return 1;
      return a.name.localeCompare(b.name);
    })
    .map(l=>({
      id:l.id, name:l.name,
      players:l.solo?1:l.names.filter(Boolean).length,
      status:l.game&&l.game.phase!=='GAME_OVER'?'playing':'waiting',
      solo:l.solo||false,
    }));
}
function broadcastLobbies(){ const list=lobbyList(); for(const ws of wss.clients) sendTo(ws,{type:'LOBBIES',lobbies:list}); }
// Pre-create 5 permanent tables + 1 solo table at startup
for(let i=0;i<MAX_LOBBIES;i++){
  const id='TABLE_'+(i+1);
  lobbies[id]={id,name:'Table '+(i+1),players:[null,null],names:['',''],game:null,graceTimers:[null,null],solo:false};
}
const SOLO_ID='SOLO';
lobbies[SOLO_ID]={id:SOLO_ID,name:'Solo vs Bot',players:[null,null],names:['',''],game:null,graceTimers:[null,null],solo:true};

function createLobby(name){ return null; } // unused - tables are permanent
function deleteLobby(id){
  // Don't delete — just reset the table
  const l=lobbies[id];
  if(!l)return;
  l.players=[null,null]; l.names=['','']; l.game=null; l.graceTimers=[null,null];
}
function freeSeat(lobby){ if(!lobby.players[0])return 0; if(!lobby.players[1])return 1; return -1; }

// ─── COMBO DETECTION ────────────────────────────────────
function analyseRoll(dice) {
  const freq={};
  dice.forEach(d=>freq[d]=(freq[d]||0)+1);
  const entries=Object.entries(freq).map(([v,c])=>({v:+v,c})).sort((a,b)=>b.c-a.c);
  const max=entries[0]?.c||0;

  // ── INSTANT WIN: 9 of a kind ──────────────────────────
  if(max===9) return {conflict:false, special:'INSTANT_WIN', combos:['INSTANT_WIN'], freq};

  // ── DOUBLE_QUAD: 8 of a kind — removes 2 cubes ───────
  if(max===8) return {conflict:false, special:'DOUBLE_QUAD', combos:['DOUBLE_QUAD'], freq};

  // ── JOKER: exactly 7 of a kind — choose any combo ────
  if(max===7) return {
    conflict:true, special:'JOKER',
    primary:['DOUBLE','TRIPLE_DOUBLE','QUAD','PENTA'],
    hasDouble:false, freq
  };

  // ── SIX OF A KIND: draw 3 cards ──────────────────────
  if(max===6) return {conflict:false, special:'SIX_OF_KIND', combos:['SIX_OF_KIND'], freq};

  // ── NORMAL COMBOS ─────────────────────────────────────
  const tripleEntry=entries.find(e=>e.c>=3);
  const dblEntry=tripleEntry?entries.find(e=>e.c>=2&&e.v!==tripleEntry.v):null;
  const hasTripleDouble=!!(tripleEntry&&dblEntry);

  const primary=[];
  if(max>=5) primary.push('PENTA');
  if(max>=4) primary.push('QUAD');
  if(hasTripleDouble) primary.push('TRIPLE_DOUBLE');

  const hasDouble=max>=2;

  if(primary.length<=1){
    const combos=[...primary];
    if(hasDouble && canDoubleCoexist(dice,primary[0])) combos.push('DOUBLE');
    return {conflict:false, special:null, combos, freq};
  }
  return {conflict:true, special:null, primary, hasDouble, freq};
}

function canDoubleCoexist(dice,chosenPrimary){
  // Under the "one combo per face" rule:
  // DOUBLE can only come from a DIFFERENT face than the one used by the primary combo.
  // Same-face leftover dice do NOT qualify for an additional DOUBLE.
  const freq={};
  dice.forEach(d=>freq[d]=(freq[d]||0)+1);
  const entries=Object.entries(freq).map(([v,c])=>({v:+v,c})).sort((a,b)=>b.c-a.c);

  // Track which faces are consumed by the primary
  const usedFaces=new Set();

  if(chosenPrimary==='PENTA'){
    const pv=entries.find(e=>e.c>=5); if(pv) usedFaces.add(pv.v);
  } else if(chosenPrimary==='QUAD'){
    const qv=entries.find(e=>e.c>=4); if(qv) usedFaces.add(qv.v);
  } else if(chosenPrimary==='TRIPLE_DOUBLE'){
    const tv=entries.find(e=>e.c>=3); if(tv) usedFaces.add(tv.v);
    const dv=tv?entries.find(e=>e.c>=2&&e.v!==tv.v):null; if(dv) usedFaces.add(dv.v);
  } else if(!chosenPrimary){
    return entries.some(e=>e.c>=2);
  }

  // DOUBLE only from faces NOT used by the primary
  return entries.some(e=>!usedFaces.has(e.v)&&e.c>=2);
}

// ─── GAME LOGIC ──────────────────────────────────────────
function dealCard(g){
  if(g.deck.length===0){if(g.discard.length===0)return null;g.deck=shuffle([...g.discard]);g.discard=[];}
  return g.deck.pop()||null;
}
function trash(g,card){ if(card) g.discard.push(card); }

function newStats(){ return {turns:0,stocked:0,stolen:0,stolenFrom:0,combos:{DOUBLE:0,TRIPLE_DOUBLE:0,QUAD:0,PENTA:0},cards:0}; }

function newGame(nameA,nameB,isSolo){
  const deck=shuffle([...INITIAL_DECK]);
  const g={
    players:[
      {name:nameA,stall:[0,0,1,1,1,1],hand:[],supply:6},
      {name:nameB,stall:[0,0,1,1,1,1],hand:[],supply:6},
    ],
    deck,discard:[],
    dice:Array(9).fill(0),
    cur:Math.floor(Math.random()*2),
    phase:'CARD_PLAY',
    sel:[],temptCount:0,
    status:'',combos:[],
    comboOptions:null,
    rollExplain:'',
    winnerIdx:null,
    isSolo:!!isSolo,
    stats:[newStats(),newStats()],
    turnGen:0,
  };
  const c0=dealCard(g);if(c0)g.players[0].hand.push(c0);
  const c1=dealCard(g);if(c1)g.players[1].hand.push(c1);
  g.status=`A mysterious ailment strikes the crowd… ${g.players[g.cur].name} goes first!`;
  return g;
}

function buildView(g,seat){
  // During ROLL_PAUSE, expose the pending combos so client can show badges
  const displayCombos = (g.phase==='ROLL_PAUSE' && g._pendingAnalysis && !g._pendingAnalysis.conflict)
    ? g._pendingAnalysis.combos
    : g.combos;
  return {
    myIdx:seat,
    myName:g.players[seat].name,
    oppName:g.players[1-seat].name,
    myHand:g.players[seat].hand,
    oppHandCount:g.players[1-seat].hand.length,
    stalls:g.players.map(p=>p.stall),
    supplies:g.players.map(p=>p.supply),
    dice:g.dice,
    phase:g.phase,
    cur:g.cur,
    isMyTurn:g.cur===seat,
    status:g.status,
    combos:displayCombos,
    comboOptions:g.comboOptions,
    comboPickReason:g._jokerRoll?'JOKER':'CONFLICT',
    rollExplain:g.rollExplain,
    sel:g.cur===seat?g.sel:[],
    winnerIdx:g.winnerIdx,
    isSolo:g.isSolo,
    stats:g.stats,
    boysAttacking:g._boysAttacking||0,
    deckCount:g.deck.length + g.discard.length,
    deckRemaining:g.deck.length,
  };
}

function broadcastGame(lobby){
  const g=lobby.game; if(!g)return;
  [0,1].forEach(seat=>{
    if(lobby.players[seat]) sendTo(lobby.players[seat],{type:'GAME_STATE',state:buildView(g,seat)});
  });
}

// ─── ACTION HANDLER ──────────────────────────────────────
function handleAction(ws,msg){
  const st=wsState.get(ws); if(!st)return;
  const lobby=lobbies[st.lobbyId]; if(!lobby)return;
  const g=lobby.game;
  const seat=st.seat;

  if(msg.type==='RESTART'){
    const lobby2=lobbies[st.lobbyId]; if(!lobby2)return;
    lobby2.game=newGame(lobby2.names[0],lobby2.solo?'The Peddler':lobby2.names[1],lobby2.solo);
    broadcastGame(lobby2);
    if(lobby2.solo&&lobby2.game&&lobby2.game.cur===1) scheduleBotTurn(lobby2,1800);
    return;
  }
  if(!g||g.winnerIdx!==null)return;

  switch(msg.type){
    case 'SELECT_CARD':
      if(g.cur!==seat||g.phase!=='CARD_PLAY')return;
      const si=g.sel.indexOf(msg.idx);
      if(si>=0)g.sel.splice(si,1);else g.sel.push(msg.idx);
      broadcastGame(lobby); break;

    case 'ROLL':
      if(g.cur!==seat||g.phase!=='CARD_PLAY'){
        // Resync client — state mismatch after reconnect
        if(lobby.players[seat]) sendTo(lobby.players[seat],{type:'GAME_STATE',state:buildView(g,seat)});
        return;
      }
      processCardPlays(lobby); break;

    case 'CONTINUE':
      if(g.cur!==seat||g.phase!=='ROLL_PAUSE'){
        if(lobby.players[seat]) sendTo(lobby.players[seat],{type:'GAME_STATE',state:buildView(g,seat)});
        return;
      }
      resolvePausedRoll(lobby); break;

    case 'REQUEST_STATE':
      if(lobby.game && lobby.players[seat])
        sendTo(lobby.players[seat],{type:'GAME_STATE',state:buildView(g,seat)});
      break;

    case 'CHOOSE_COMBO':
      if(g.cur!==seat||g.phase!=='CHOOSE_COMBO')return;
      resolveChosenCombo(lobby,msg.combo); break;

    case 'BOY_DEFEND':
      if(g.phase!=='BOY_DEFEND'||seat!==1-g.cur)return;
      {
        const bulliesPlayed=Math.min(
          Math.max(0, msg.bulliesPlayed||0),
          g._boysAttacking||0,
          g.players[seat].hand.filter(c=>c==='BULLY').length
        );
        // Spend the bullies
        let spent=0;
        while(spent<bulliesPlayed){
          const bi=g.players[seat].hand.indexOf('BULLY');
          if(bi<0) break;
          g.players[seat].hand.splice(bi,1); trash(g,'BULLY'); g.stats[seat].cards++; spent++;
        }
        const attacks=g._boysAttacking||1;
        const steals=attacks-bulliesPlayed;
        const stallBottles=g.players[1-g.cur].stall.filter(s=>s===2).length;
        const actualSteals=Math.min(steals, stallBottles);
        for(let i=0;i<actualSteals;i++) doSteal(g);
        const parts=[];
        if(bulliesPlayed>0) parts.push(`${g.players[seat].name} blocks ${bulliesPlayed} attack${bulliesPlayed>1?'s':''} with ${bulliesPlayed===1?'a Bully':'Bullies'}`);
        if(actualSteals>0) parts.push(`${g.players[g.cur].name} steals ${actualSteals} bottle${actualSteals>1?'s':''}`);
        if(actualSteals===0&&bulliesPlayed>0) parts.push('all attacks blocked!');
        if(actualSteals===0&&bulliesPlayed===0) parts.push(`${g.players[g.cur].name}'s Boys find an empty stall`);
        g.status=parts.join(' — ')+'!';
        g._boysAttacking=0;
      }
      rollAndResolve(lobby); break;

    case 'BLIND_PICK':
      if(g.phase!=='BLIND_PICK'||seat!==g.cur)return;
      const opp=g.players[1-g.cur];
      if(msg.cardIdx<0||msg.cardIdx>=opp.hand.length)return;
      trash(g,opp.hand.splice(msg.cardIdx,1)[0]);
      g.status=`${g.players[g.cur].name} blindly picks a card from ${g.players[1-g.cur].name}'s hand!`;
      rollAndResolve(lobby); break;


    case 'DISCARD':
      if(g.phase!=='DISCARD'||seat!==g.cur)return;
      const p=g.players[g.cur];
      if(msg.cardIdx<0||msg.cardIdx>=p.hand.length)return;
      trash(g,p.hand.splice(msg.cardIdx,1)[0]);
      if(p.hand.length<=3)endTurn(g,lobby);
      else broadcastGame(lobby); break;
  }
}

function processCardPlays(lobby){
  const g=lobby.game;
  const p=g.players[g.cur],opp=g.players[1-g.cur];
  const indices=[...g.sel].sort((a,b)=>b-a);
  const played=indices.map(i=>p.hand[i]);
  indices.forEach(i=>p.hand.splice(i,1));
  g.sel=[];
  const tempt=played.filter(c=>c==='TEMPTRESS').length;
  const boys=played.filter(c=>c==='BOY').length;
  const bullies=played.filter(c=>c==='BULLY').length;
  g.temptCount=tempt;
  // Track cards played
  g.stats[g.cur].cards+=played.length;
  for(let t=0;t<tempt;t++) trash(g,'TEMPTRESS');

  if(bullies>=2&&boys===0){
    // Bot never does blind pick — just rolls
    if(g.isSolo&&g.cur===1){
      for(let b=0;b<bullies;b++) trash(g,'BULLY');
      g.status=`The Peddler cracks their knuckles menacingly…`;
      rollAndResolve(lobby); return;
    }
    for(let b=0;b<bullies;b++) trash(g,'BULLY');
    if(opp.hand.length>0){
      g.phase='BLIND_PICK';
      g.status=`${p.name} plays 2 Bullies! Pick a card blindly from ${opp.name}'s hand.`;
      broadcastGame(lobby); return;
    }
    g.status=`The Bullies flex — but ${opp.name} has an empty hand!`;
    rollAndResolve(lobby); return;
  }
  for(let b=0;b<bullies;b++) trash(g,'BULLY');
  if(boys>0){
    for(let b=0;b<boys;b++) trash(g,'BOY');
    const stallBottles=opp.stall.filter(s=>s===2).length;
    if(stallBottles===0){
      g.status=`The Boy reaches out — ${opp.name}'s stall is bare!`;
      rollAndResolve(lobby); return;
    }
    const bulliesAvailable=opp.hand.filter(c=>c==='BULLY').length;
    g._boysAttacking=boys;
    if(bulliesAvailable===0){
      // No defence possible — steals happen immediately
      const actualSteals=Math.min(boys, stallBottles);
      for(let i=0;i<actualSteals;i++) doSteal(g);
      g.status=`${p.name} plays ${boys===1?'The Boy':'2 Boys'} — steals ${actualSteals} bottle${actualSteals>1?'s':''}!`;
      g._boysAttacking=0;
      rollAndResolve(lobby); return;
    }
    // Defender has at least one Bully — show defend overlay
    g.phase='BOY_DEFEND';
    const maxBlock=Math.min(bulliesAvailable, boys);
    g.status=`${p.name} plays ${boys===1?'The Boy':boys+' Boys'}! ${opp.name}, you have ${bulliesAvailable} Bull${bulliesAvailable>1?'ies':'y'} — block up to ${maxBlock} attack${maxBlock>1?'s':''}.`;
    broadcastGame(lobby);
    if(g.isSolo&&1-g.cur===1) setTimeout(()=>botDefend(lobby),1400);
    return;
  }
  rollAndResolve(lobby);
}

function doSteal(g){
  const opp=g.players[1-g.cur];
  const slots=opp.stall.map((s,i)=>s===2?i:-1).filter(i=>i>=0);
  if(!slots.length)return;
  opp.stall[slots[slots.length-1]]=1; opp.supply++;
  g.stats[g.cur].stolen++;
  g.stats[1-g.cur].stolenFrom++;
  g.status=`Quick hands! ${g.players[g.cur].name} steals a bottle from ${g.players[1-g.cur].name}'s stall!`;
}

function rollAndResolve(lobby){
  const g=lobby.game;
  g.dice=Array.from({length:9},()=>Math.ceil(Math.random()*6));
  g.rollExplain=describeRoll(g.dice);
  g._pendingAnalysis=analyseRoll(g.dice);

  // Pause so player can see dice before resolution
  g.phase='ROLL_PAUSE';
  g.combos=[];
  g.comboOptions=null;
  const analysis=g._pendingAnalysis;
  if(analysis.conflict){
    g.status=`${g.players[g.cur].name} rolled! See the dice — then continue to choose your combo.`;
  } else if(analysis.combos.length){
    const names={PENTA:'Penta',QUAD:'Quad',TRIPLE_DOUBLE:'Triple + Double',DOUBLE:'Double'};
    const labels=analysis.combos.map(c=>names[c]||c).join(' + ');
    g.status=`${g.players[g.cur].name} rolled ${labels}! Continue to resolve.`;
  } else {
    g.status=`${g.players[g.cur].name} rolled — no combos. Continue to end turn.`;
  }
  broadcastGame(lobby);
  // Bot auto-continues through ROLL_PAUSE — human must click Continue
  if(g.isSolo&&g.cur===1){
    const gen=g.turnGen;
    setTimeout(()=>{ if(g.turnGen===gen&&g.cur===1&&g.phase==='ROLL_PAUSE') resolvePausedRoll(lobby); },2200);
  }
}

function resolvePausedRoll(lobby){
  const g=lobby.game;
  if(!g||g.phase!=='ROLL_PAUSE')return;
  const analysis=g._pendingAnalysis;
  g._pendingAnalysis=null;

  // ── INSTANT WIN ────────────────────────────────────────
  if(analysis.special==='INSTANT_WIN'){
    g.comboOptions=null;
    applyComboList(lobby,['INSTANT_WIN']);
    return;
  }

  // ── JOKER or normal conflict ───────────────────────────
  if(analysis.conflict){
    g.phase='CHOOSE_COMBO';
    g.comboOptions=analysis.primary;
    g.combos=[];
    g._jokerRoll=analysis.special==='JOKER'; // flag for resolveChosenCombo
    const msg=g._jokerRoll
      ? `${g.players[g.cur].name} rolled 7 of a kind — the Joker! Choose any previous combo.`
      : `${g.players[g.cur].name} rolled! Conflicting combos — choose one to use.`;
    g.status=msg;
    broadcastGame(lobby);
    if(g.isSolo&&g.cur===1) scheduleBotTurn(lobby,1000);
  } else {
    g._jokerRoll=false;
    g.comboOptions=null;
    applyComboList(lobby,analysis.combos);
  }
}

function resolveChosenCombo(lobby,chosen){
  const g=lobby.game;
  g.comboOptions=null;

  const combos=[chosen];
  // Joker uses all 7 dice of the same face — no other face can give a DOUBLE
  if(!g._jokerRoll && canDoubleCoexist(g.dice,chosen)) combos.push('DOUBLE');
  g._jokerRoll=false;
  applyComboList(lobby,combos);
}

function applyComboList(lobby,combos){
  const g=lobby.game;
  g.combos=combos;
  const p=g.players[g.cur],opp=g.players[1-g.cur];
  const msgs=[];

  // ── INSTANT WIN (9 of a kind) ──────────────────────────
  if(combos.includes('INSTANT_WIN')){
    g.phase='GAME_OVER'; g.winnerIdx=g.cur;
    g.status=`${p.name} rolled NINE of a kind! An impossible feat — instant victory!`;
    broadcastGame(lobby); return;
  }

  // ── DOUBLE QUAD (8 of a kind) — remove 2 cubes ────────
  if(combos.includes('DOUBLE_QUAD')){
    g.stats[g.cur].combos.QUAD+=2;
    let removed=0;
    for(let i=0;i<2;i++){
      const slot=p.stall.findIndex(s=>s===0);
      if(slot>=0){p.stall[slot]=1;removed++;}
    }
    msgs.push(removed>0
      ?`Eight of a kind — ${removed} cube${removed>1?'s':''} removed!`
      :`Eight of a kind — no cubes left to remove`);
  }

  // ── SIX OF A KIND — draw 3 cards ──────────────────────
  if(combos.includes('SIX_OF_KIND')){
    let drawn=0;
    for(let i=0;i<3;i++){
      const c=dealCard(g);
      if(c){p.hand.push(c);drawn++;}
    }
    g.stats[g.cur].cards+=drawn;
    msgs.push(drawn>0
      ?`Six of a kind — drew ${drawn} card${drawn>1?'s':''}!`
      :`Six of a kind — deck empty, nothing to draw`);
  }

  if(combos.includes('DOUBLE')){
    g.stats[g.cur].combos.DOUBLE++;
    const c=dealCard(g);
    if(c){p.hand.push(c);msgs.push(`Double — drew a card (${c.charAt(0)+c.slice(1).toLowerCase()})`);}
    else msgs.push('Double — deck empty, nothing to draw');
  }
  if(combos.includes('TRIPLE_DOUBLE')){
    g.stats[g.cur].combos.TRIPLE_DOUBLE++;
    const total=1+g.temptCount;let placed=0;
    for(let b=0;b<total;b++){
      const slot=p.stall.findIndex(s=>s===1);
      if(slot>=0&&p.supply>0){p.stall[slot]=2;p.supply--;placed++;g.stats[g.cur].stocked++;}
    }
    msgs.push(placed>0
      ?`Triple+Double — ${placed} bottle${placed>1?'s':''} stocked${g.temptCount>0?' (Temptress bonus!)':''}`
      :`Triple+Double — no free slots available`);
  }
  g.temptCount=0;
  if(combos.includes('QUAD')){
    g.stats[g.cur].combos.QUAD++;
    const slot=p.stall.findIndex(s=>s===0);
    if(slot>=0){p.stall[slot]=1;msgs.push(`Quad — slot ${slot+1} is now open!`);}
    else msgs.push('Quad — all slots already open');
  }
  if(combos.includes('PENTA')){
    g.stats[g.cur].combos.PENTA++;
    opp.hand.forEach(c=>trash(g,c));opp.hand=[];
    msgs.push(`Penta — ${opp.name} discards their entire hand!`);
  }
  if(!combos.length) msgs.push('No combos this roll. The crowd moves on…');

  g.status=msgs.join(' · ');

  if(p.stall.filter(s=>s===2).length===6){
    g.phase='GAME_OVER';g.winnerIdx=g.cur;
    g.status=`${p.name} stocks their 6th bottle — the crowd goes wild!`;
    broadcastGame(lobby);return;
  }
  if(p.hand.length>3){
    g.phase='DISCARD';
    broadcastGame(lobby);
    if(g.isSolo&&g.cur===1) scheduleBotTurn(lobby,1000);
    return;
  }
  endTurn(g,lobby);
}

function describeRoll(dice){
  const freq={};
  dice.forEach(d=>freq[d]=(freq[d]||0)+1);
  const parts=Object.entries(freq)
    .sort((a,b)=>b[1]-a[1])
    .map(([v,c])=>c===1?`one ${v}`:`${['','','two','three','four','five','six','seven','eight','nine'][c]||c+'×'} ${v}s`);
  return parts.join(', ');
}

function endTurn(g,lobby){
  g.stats[g.cur].turns++;
  g.cur=1-g.cur;g.phase='CARD_PLAY';g.sel=[];g.combos=[];g.comboOptions=null;g.rollExplain='';
  g.turnGen++;
  g.status=`${g.players[g.cur].name}'s turn — play cards or roll the dice.`;
  broadcastGame(lobby);
  if(g.isSolo&&g.cur===1) scheduleBotTurn(lobby,1600);
}

// Single entry point for all bot scheduling — always checks cur===1 and turnGen
function scheduleBotTurn(lobby,delay){
  const g=lobby.game;
  const gen=g.turnGen;
  setTimeout(()=>{
    if(!g||g.turnGen!==gen||g.cur!==1||!g.isSolo||g.winnerIdx!==null)return;
    botTurn(lobby);
  }, delay||1400);
}

// ─── BOT AI ──────────────────────────────────────────────
function botTurn(lobby){
  const g=lobby.game;
  // Hard safety check — never run bot logic on human's turn
  if(!g||g.winnerIdx!==null||g.cur!==1||!g.isSolo)return;

  if(g.phase==='CARD_PLAY'){
    const bot=g.players[1], opp=g.players[0];
    g.sel=[];
    bot.hand.forEach((c,i)=>{ if(c==='TEMPTRESS') g.sel.push(i); });
    if(!g.sel.length){
      const boyIdx=bot.hand.indexOf('BOY');
      if(boyIdx>=0&&opp.stall.some(s=>s===2)) g.sel.push(boyIdx);
    }
    broadcastGame(lobby);
    const gen=g.turnGen;
    setTimeout(()=>{
      if(g.turnGen!==gen||g.cur!==1||g.phase!=='CARD_PLAY')return;
      processCardPlays(lobby);
    },1400);
    return;
  }
  if(g.phase==='CHOOSE_COMBO'){
    // Bot priority for Joker (6 or 7 of a kind): PENTA > QUAD > TRIPLE_DOUBLE > DOUBLE
    const order=['PENTA','QUAD','TRIPLE_DOUBLE','DOUBLE'];
    const choice=order.find(k=>g.comboOptions.includes(k))||g.comboOptions[0];
    const gen=g.turnGen;
    setTimeout(()=>{
      if(g.turnGen!==gen||g.cur!==1||g.phase!=='CHOOSE_COMBO')return;
      resolveChosenCombo(lobby,choice);
    },900);
    return;
  }
  if(g.phase==='DISCARD'){
    const gen=g.turnGen;
    setTimeout(()=>{
      if(g.turnGen!==gen||g.cur!==1||g.phase!=='DISCARD')return;
      const p=g.players[1];
      if(p.hand.length<=3){endTurn(g,lobby);return;}
      const priority={'BULLY':3,'BOY':2,'TEMPTRESS':1};
      let discardIdx=0, lowestPri=99;
      p.hand.forEach(function(c,i){
        const pri=priority[c]||0;
        if(pri<lowestPri){lowestPri=pri;discardIdx=i;}
      });
      trash(g,p.hand.splice(discardIdx,1)[0]);
      if(p.hand.length<=3) endTurn(g,lobby);
      else{ broadcastGame(lobby); botTurn(lobby); }
    },900);
    return;
  }
}

function botDefend(lobby){
  const g=lobby.game; if(!g||g.phase!=='BOY_DEFEND'||g.cur!==0||!g.isSolo)return;
  const bot=g.players[1];
  const attacks=g._boysAttacking||1;
  const bulliesAvailable=bot.hand.filter(c=>c==='BULLY').length;
  // Bot always blocks as many as possible
  const bulliesPlayed=Math.min(bulliesAvailable, attacks);
  // Simulate BOY_DEFEND message directly
  let spent=0;
  while(spent<bulliesPlayed){
    const bi=bot.hand.indexOf('BULLY');
    if(bi<0) break;
    bot.hand.splice(bi,1); trash(g,'BULLY'); g.stats[1].cards++; spent++;
  }
  const steals=attacks-bulliesPlayed;
  const stallBottles=g.players[0].stall.filter(s=>s===2).length;
  const actualSteals=Math.min(steals, stallBottles);
  for(let i=0;i<actualSteals;i++) doSteal(g);
  const parts=[];
  if(bulliesPlayed>0) parts.push(`${bot.name} blocks ${bulliesPlayed} attack${bulliesPlayed>1?'s':''} with ${bulliesPlayed===1?'a Bully':'Bullies'}`);
  if(actualSteals>0) parts.push(`${g.players[0].name} steals ${actualSteals} bottle${actualSteals>1?'s':''}`);
  if(actualSteals===0&&bulliesPlayed>0) parts.push('all attacks blocked!');
  g.status=parts.join(' — ')+(parts.length?'!':'');
  g._boysAttacking=0;
  rollAndResolve(lobby);
}

// ─── HTTP ────────────────────────────────────────────────
const fs=require('fs'), path=require('path');

const MANIFEST_JSON = JSON.stringify({
  name: 'Nine Oils',
  short_name: 'Nine Oils',
  description: 'A game of luck and will',
  start_url: '/',
  display: 'standalone',
  background_color: '#120a02',
  theme_color: '#120a02',
  orientation: 'portrait-primary',
  icons: [
    { src: '/icon-192.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'any maskable' },
    { src: '/icon-512.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any maskable' },
  ]
});

const ICON_SVG = (size) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" rx="${size*0.18}" fill="#120a02"/><rect x="${size*0.03}" y="${size*0.03}" width="${size*0.94}" height="${size*0.94}" rx="${size*0.16}" fill="none" stroke="#c49030" stroke-width="${size*0.025}" opacity=".6"/><text x="${size/2}" y="${size*0.73}" text-anchor="middle" font-family="Georgia,serif" font-weight="900" font-size="${size*0.65}" fill="#d4a843">9</text></svg>`;

const server=http.createServer((req,res)=>{
  const url = req.url.split('?')[0];
  if(url === '/manifest.json'){
    res.writeHead(200,{'Content-Type':'application/manifest+json'});
    res.end(MANIFEST_JSON); return;
  }
  if(url === '/icon-192.svg' || url === '/icon-512.svg'){
    const size = url.includes('512') ? 512 : 192;
    res.writeHead(200,{'Content-Type':'image/svg+xml','Cache-Control':'public,max-age=86400'});
    res.end(ICON_SVG(size)); return;
  }
  if(req.url.startsWith('/img/')){
    const file=path.join(__dirname,'img',path.basename(req.url.split('?')[0]));
    fs.readFile(file,(err,data)=>{
      if(err){res.writeHead(404);res.end();return;}
      const ext=path.extname(file).slice(1).replace('jpg','jpeg');
      res.writeHead(200,{'Content-Type':'image/'+ext,'Cache-Control':'public,max-age=86400'});
      res.end(data);
    });
    return;
  }
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
  res.end(CLIENT_HTML);
});

// ─── SERVER HEARTBEAT (keeps Railway proxy alive) ────────
setInterval(()=>{
  for(const ws of wss.clients){
    if(ws.readyState===1) ws.ping();
  }
}, 20000);

// ─── WEBSOCKET ───────────────────────────────────────────
const wss=new WebSocketServer({server});
wss.on('connection',(ws,req)=>{
  sendTo(ws,{type:'LOBBIES',lobbies:lobbyList()});

  ws.on('pong',()=>{ ws._lastPong=Date.now(); });

  ws.on('message',raw=>{
    let msg;try{msg=JSON.parse(raw);}catch{return;}
    if(msg.type==='PING'){sendTo(ws,{type:'PONG'});return;}

    // ── RECONNECT: player comes back after a drop ──
    if(msg.type==='RECONNECT'){
      const sess=sessions[msg.token];
      if(!sess){sendTo(ws,{type:'RECONNECT_FAIL'});return;}
      const lobby=lobbies[sess.lobbyId];
      if(!lobby){delete sessions[msg.token];sendTo(ws,{type:'RECONNECT_FAIL'});return;}
      // Cancel grace timer if running
      if(lobby.graceTimers&&lobby.graceTimers[sess.seat]){
        clearTimeout(lobby.graceTimers[sess.seat]);
        lobby.graceTimers[sess.seat]=null;
      }
      lobby.players[sess.seat]=ws;
      wsState.set(ws,{lobbyId:sess.lobbyId,seat:sess.seat,token:msg.token});
      console.log(`[~] ${sess.name} reconnected to lobby ${sess.lobbyId} seat ${sess.seat}`);
      sendTo(ws,{type:'RECONNECTED',lobbyId:sess.lobbyId,seat:sess.seat});
      // Notify opponent
      const other=lobby.players[1-sess.seat];
      if(other) sendTo(other,{type:'OPPONENT_RECONNECTED',name:sess.name});
      // Restore game state
      if(lobby.game) {
        broadcastGame(lobby);
        // Solo: if bot's turn is active but possibly stuck, reschedule (turnGen check prevents double-fire)
        const g2=lobby.game;
        if(g2.isSolo && g2.cur===1 && g2.winnerIdx===null &&
           (g2.phase==='CARD_PLAY'||g2.phase==='CHOOSE_COMBO'||g2.phase==='DISCARD')){
          scheduleBotTurn(lobby, 2000);
        }
      }
      else sendTo(ws,{type:'LOBBIES',lobbies:lobbyList()});
      return;
    }


    if(msg.type==='JOIN_LOBBY'){
      const lobby=lobbies[msg.lobbyId];
      if(!lobby){sendTo(ws,{type:'ERROR',text:'Table not found.'});return;}
      if(lobby.game&&lobby.game.phase!=='GAME_OVER'){sendTo(ws,{type:'ERROR',text:'Game in progress.'});return;}

      // Solo table: always seat 0 for human, reset bot seat
      const seat=lobby.solo?0:freeSeat(lobby);
      if(seat<0){sendTo(ws,{type:'ERROR',text:'This table is full.'});return;}
      const token=uid()+uid();
      lobby.players[seat]=ws;lobby.names[seat]=msg.playerName||`Player ${seat+1}`;
      if(lobby.solo){ lobby.players[1]=null; lobby.names[1]='The Peddler'; }
      if(!lobby.graceTimers) lobby.graceTimers=[null,null];
      wsState.set(ws,{lobbyId:lobby.id,seat,token});
      sessions[token]={lobbyId:lobby.id,seat,name:lobby.names[seat]};
      sendTo(ws,{type:'JOINED',lobbyId:lobby.id,seat,lobbyName:lobby.name,token,solo:lobby.solo});
      broadcastLobbies();

      if(lobby.solo){
        // Start immediately vs bot
        lobby.game=newGame(lobby.names[0],'The Peddler',true);
        broadcastGame(lobby);
        broadcastLobbies();
        // If bot goes first, schedule its turn
        if(lobby.game&&lobby.game.isSolo&&lobby.game.cur===1) scheduleBotTurn(lobby,1800);
      } else {
        if(lobby.players[1-seat]) sendTo(lobby.players[1-seat],{type:'OPPONENT_JOINED',name:lobby.names[seat]});
        if(lobby.players[0]&&lobby.players[1]){
          lobby.game=newGame(lobby.names[0],lobby.names[1],false);
          broadcastGame(lobby);broadcastLobbies();
        }
      }
      return;
    }
    if(msg.type==='LEAVE_LOBBY'){hardLeave(ws);broadcastLobbies();return;}
    handleAction(ws,msg);
  });

  ws.on('close',()=>{
    const st=wsState.get(ws);
    if(!st){broadcastLobbies();return;}
    wsState.delete(ws);
    const lobby=lobbies[st.lobbyId];
    if(!lobby){broadcastLobbies();return;}
    // Mark seat as empty WS but keep name + game — start grace timer
    lobby.players[st.seat]=null;
    console.log(`[~] ${lobby.names[st.seat]} disconnected — grace period ${GRACE_MS}ms`);
    const other=lobby.players[1-st.seat];
    if(other) sendTo(other,{type:'OPPONENT_DISCONNECTED_GRACE',name:lobby.names[st.seat],graceMs:GRACE_MS});
    if(!lobby.graceTimers) lobby.graceTimers=[null,null];
    lobby.graceTimers[st.seat]=setTimeout(()=>{
      console.log(`[x] Grace expired for seat ${st.seat} in lobby ${st.lobbyId}`);
      hardLeaveBySlot(lobby,st.seat);
      broadcastLobbies();
    }, GRACE_MS);
  });

  ws.on('error',err=>console.log(`[!] WS: ${err.message}`));
});

// Hard leave — clears everything permanently
function hardLeave(ws){
  const st=wsState.get(ws);if(!st)return;
  wsState.delete(ws);
  const lobby=lobbies[st.lobbyId];if(!lobby)return;
  if(sessions[st.token]) delete sessions[st.token];
  hardLeaveBySlot(lobby,st.seat);
}

function hardLeaveBySlot(lobby,seat){
  // Cancel grace timer
  if(lobby.graceTimers&&lobby.graceTimers[seat]){
    clearTimeout(lobby.graceTimers[seat]);
    lobby.graceTimers[seat]=null;
  }
  // Clear session tokens for this seat
  for(const [tok,s] of Object.entries(sessions)){
    if(s.lobbyId===lobby.id&&s.seat===seat) delete sessions[tok];
  }
  // Clear the seat
  lobby.players[seat]=null;
  lobby.names[seat]='';
  // Notify the other player
  const other=lobby.players[1-seat];
  if(other) sendTo(other,{type:'OPPONENT_LEFT'});
  // Always reset game - table stays open for new players
  lobby.game=null;
  // If both gone, fully reset names too
  if(!lobby.players[0]&&!lobby.players[1]){
    lobby.names=['',''];
    lobby.graceTimers=[null,null];
  }
  console.log(`[=] Table ${lobby.name} reset. Seats: ${lobby.names.map((n,i)=>n||'empty').join(' | ')}`);
}

// ─── START ───────────────────────────────────────────────
server.listen(PORT,()=>{
  console.log('\n🎪  Nine Oils Server\n');
  console.log(`  Local:   http://localhost:${PORT}`);
  Object.values(networkInterfaces()).flat()
    .filter(i=>i.family==='IPv4'&&!i.internal)
    .forEach(i=>console.log(`  Network: http://${i.address}:${PORT}`));
  console.log('\nWaiting for players…\n');
});

// ════════════════════════════════════════════════════════════
//  CLIENT HTML
// ════════════════════════════════════════════════════════════
const CLIENT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Nine Oils</title>
<meta name="theme-color" content="#120a02">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Nine Oils">
<link rel="manifest" href="/manifest.json">
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='12' fill='%23120a02'/><rect x='2' y='2' width='60' height='60' rx='11' fill='none' stroke='%23c49030' stroke-width='1.5' opacity='.6'/><text x='32' y='47' text-anchor='middle' font-family='Georgia,serif' font-weight='900' font-size='42' fill='%23d4a843'>9</text></svg>">
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=Playfair+Display:wght@900&family=Crimson+Text:ital,wght@0,400;0,600;1,400;1,600&family=IM+Fell+English:ital@0;1&display=swap" rel="stylesheet">
<style>
:root{
  /* Palette inspired by the card engravings — aged parchment, sepia ink, warm dark wood */
  --wood-dark:#120a02;--wood:#1e1108;--wood-mid:#2a1808;--wood-light:#362010;
  --felt:#160e06;--felt-mid:#1c1208;
  --amber:#b87808;--gold:#c49030;--gold-light:#d8a840;
  --cream:#ede0bb;--cream-dark:#b8a070;
  --red:#5a1010;--red-light:#a82828;
  --green:#1e4220;--green-light:#2e7038;
  --border:rgba(140,95,30,.42);--border-bright:rgba(196,144,48,.65);
  --parchment:#d4b87a;--ink:#1a0f05;
}
*{box-sizing:border-box;margin:0;padding:0;writing-mode:horizontal-tb!important;direction:ltr!important}
body{background:#0c0702;background-image:repeating-linear-gradient(90deg,rgba(255,255,255,0) 0,rgba(255,255,255,0) 3px,rgba(255,255,255,.012) 3px,rgba(255,255,255,.012) 4px),repeating-linear-gradient(0deg,rgba(0,0,0,0) 0,rgba(0,0,0,0) 10px,rgba(0,0,0,.04) 10px,rgba(0,0,0,.04) 11px);min-height:100vh;font-family:'Crimson Text',serif;color:var(--cream)}

/* ── CONN BAR ── */
#conn-bar{background:rgba(0,0,0,.5);border-bottom:1px solid rgba(160,112,40,.2);padding:.3rem 1rem;display:flex;align-items:center;gap:.45rem;font-size:.72rem;color:var(--cream-dark);font-family:'Cinzel',serif;letter-spacing:.07em}
.conn-dot{width:7px;height:7px;border-radius:50%;background:#555;flex-shrink:0}
.conn-dot.ok{background:#3aad60}.conn-dot.wait{background:var(--amber);animation:pulse 1.2s infinite}.conn-dot.err{background:var(--red-light)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

/* ── HEADER ── */
.header{text-align:center;padding:.9rem 1rem .3rem;background:linear-gradient(180deg,rgba(8,4,1,.98),rgba(14,8,3,.95));border-bottom:1px solid rgba(140,95,30,.3)}
.header h1{font-family:'Playfair Display',serif;font-size:clamp(1.8rem,4.5vw,2.8rem);font-weight:900;color:var(--gold);letter-spacing:.12em;text-shadow:0 0 18px rgba(212,168,67,.3),0 3px 8px rgba(0,0,0,.8)}
.header .tagline{font-family:'IM Fell English',serif;font-style:italic;color:var(--cream-dark);font-size:.85rem;margin-top:.2rem}

/* ── SCREENS ── */
.screen{display:none;padding:.5rem}
.screen.active{display:block}

/* ── LOBBY SCREEN ── */
.lobby-wrap{max-width:600px;margin:0 auto;display:flex;flex-direction:column;gap:.8rem}
.panel{background:linear-gradient(160deg,#281606,#1a0e04,#0e0802);border:1.5px solid var(--border);border-radius:12px;padding:1.2rem 1.4rem}
.panel h2{font-family:'Cinzel',serif;font-size:1rem;color:var(--gold-light);letter-spacing:.12em;margin-bottom:.9rem}
.name-form{display:flex;flex-direction:column;gap:.8rem;align-items:center}
.name-input{font-family:'Cinzel',serif;font-size:.95rem;background:rgba(0,0,0,.3);border:1.5px solid var(--border);border-radius:8px;padding:.65rem 1rem;color:var(--cream);width:100%;max-width:300px;text-align:center;letter-spacing:.06em;outline:none;transition:border-color .2s}
.name-input:focus{border-color:var(--gold)}
.name-input::placeholder{color:rgba(200,184,136,.3);font-style:italic}
.lobby-list{display:flex;flex-direction:column;gap:.45rem}
.lobby-row{display:flex;align-items:center;gap:.6rem;background:rgba(0,0,0,.18);border:1px solid rgba(160,112,40,.22);border-radius:9px;padding:.65rem .9rem;cursor:pointer;transition:all .2s}
.lobby-row:hover:not(.disabled){border-color:var(--gold);background:rgba(0,0,0,.28)}
.lobby-row.disabled{opacity:.45;cursor:default}
.lobby-num{font-family:'Cinzel',serif;font-size:.7rem;color:var(--gold-light);opacity:.65;min-width:52px;letter-spacing:.08em}
.lobby-players{flex:1;display:flex;gap:.4rem;flex-wrap:wrap}
.lobby-pip{font-size:.85rem;color:var(--cream);font-style:italic;background:rgba(212,168,67,.08);border:1px solid rgba(212,168,67,.18);border-radius:16px;padding:.12rem .55rem}
.lobby-empty-text{font-size:.8rem;color:rgba(200,184,136,.3);font-style:italic}
.lobby-badge{font-size:.7rem;font-family:'Cinzel',serif;letter-spacing:.06em;padding:.18rem .55rem;border-radius:10px;white-space:nowrap}
.badge-open{color:#3aad60;border:1px solid rgba(58,173,96,.3);background:rgba(58,173,96,.08)}
.badge-waiting{color:var(--gold);border:1px solid rgba(212,168,67,.3);background:rgba(212,168,67,.08)}
.badge-playing{color:rgba(200,184,136,.4);border:1px solid rgba(200,184,136,.15)}
.waiting-box{text-align:center;padding:.8rem 0}
.big-icon{font-size:2.8rem;line-height:1;margin-bottom:.6rem}
.waiting-box h3{font-family:'Cinzel',serif;font-size:1rem;color:var(--gold-light);letter-spacing:.1em;margin-bottom:.4rem}
.waiting-box p{color:var(--cream-dark);font-style:italic;font-size:.9rem;line-height:1.5}
.dots::after{content:'...';animation:dotanim 1.5s steps(4,end) infinite}
@keyframes dotanim{0%,100%{content:''}25%{content:'.'}50%{content:'..'}75%{content:'...'}}
.gold-line{height:1px;background:linear-gradient(90deg,transparent,var(--border-bright),transparent);margin:.55rem 0}

/* ── BUTTONS ── */
.btn{font-family:'Cinzel',serif;font-size:.78rem;letter-spacing:.09em;padding:.5rem 1.2rem;border:1.5px solid var(--gold);border-radius:6px;background:linear-gradient(165deg,var(--wood-light),var(--wood-dark));color:var(--gold-light);cursor:pointer;transition:all .2s;box-shadow:2px 2px 8px rgba(0,0,0,.5);white-space:nowrap}
.btn:hover:not(:disabled){background:linear-gradient(165deg,var(--amber),var(--wood-mid));color:var(--cream);box-shadow:0 0 12px rgba(200,134,10,.35)}
.btn:disabled{opacity:.3;cursor:not-allowed}
.btn.sm{font-size:.7rem;padding:.38rem .85rem}
.btn.danger{border-color:var(--red-light);color:#e87070}
.btn.danger:hover:not(:disabled){background:linear-gradient(165deg,var(--red),var(--wood-dark));color:var(--cream)}
.btn-row{display:flex;gap:.45rem;flex-wrap:wrap;justify-content:center}

/* ── GAME LAYOUT ── */
#screen-game{padding:.4rem .5rem}
.game-layout{display:flex;gap:.6rem;align-items:flex-start;max-width:820px;margin:0 auto}
.game-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:.5rem}

/* ── PLAYER AREA: stall left, hand right ── */
.player-body{display:flex;gap:.7rem;align-items:flex-start}
.stall{display:flex;gap:.42rem;flex-wrap:wrap;flex:0 0 auto}
.hand-col{display:flex;flex-direction:column;gap:.3rem;flex:1;min-width:0}

/* ── RULES ACCORDION (below game) ── */
.rules-accordion{background:linear-gradient(160deg,#221408,#180e05);border:1.5px solid var(--border);border-radius:12px;overflow:hidden;margin-top:.1rem}
.rules-accordion-toggle{width:100%;background:none;border:none;cursor:pointer;padding:.55rem 1rem;display:flex;align-items:center;justify-content:space-between;font-family:'Cinzel',serif;font-size:.75rem;color:var(--gold-light);letter-spacing:.1em}
.rules-accordion-toggle:hover{background:rgba(255,255,255,.03)}
.rules-accordion-caret{font-size:.7rem;transition:transform .25s;color:var(--gold);opacity:.7}
.rules-accordion.open .rules-accordion-caret{transform:rotate(180deg)}
.rules-accordion-body{display:none;padding:.2rem 1rem .8rem;font-size:.82rem;line-height:1.6}
.rules-accordion.open .rules-accordion-body{display:block}
.rules-cols{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
.rules-section{padding-top:.55rem;border-top:1px solid rgba(160,112,40,.2)}
.rules-section:first-child{border-top:none;padding-top:0}
.rules-section h3{font-family:'Cinzel',serif;font-size:.75rem;color:var(--gold-light);letter-spacing:.12em;margin-bottom:.35rem}
.combo-entry{margin-bottom:.45rem}
.combo-name{font-family:'Cinzel',serif;font-size:.65rem;color:var(--cream);letter-spacing:.07em}
.combo-dice{font-size:.7rem;color:var(--cream-dark)}
.combo-effect{font-size:.72rem;color:var(--green-light);font-style:italic}
.card-rule{margin-bottom:.55rem}
.card-rule-name{font-family:'Cinzel',serif;font-size:.7rem;color:var(--gold-light);margin-bottom:.15rem}
.card-rule-text{font-size:.72rem;color:var(--cream-dark);line-height:1.45}/* ── RULES SIDEBAR ── */
.rules-section h3{font-family:'Cinzel',serif;font-size:.78rem;color:var(--gold-light);letter-spacing:.12em;margin-bottom:.3rem}
.rules-section{border-top:1px solid rgba(160,112,40,.2);padding-top:.55rem}
.rules-section:first-child{border-top:none;padding-top:0}
.combo-entry{margin-bottom:.5rem}
.combo-name{font-family:'Cinzel',serif;font-size:.7rem;color:var(--gold);letter-spacing:.07em}
.combo-dice{font-size:.75rem;color:var(--cream-dark);font-style:italic}
.combo-effect{font-size:.75rem;color:var(--cream)}
.card-rule{margin-bottom:.45rem}
.card-rule-name{font-family:'Cinzel',serif;font-size:.68rem;color:var(--gold-light)}
.card-rule-text{font-size:.72rem;color:var(--cream-dark);line-height:1.4}

/* ── STALL ANIMATIONS ── */
@keyframes bottleIn{0%{transform:scale(0) rotate(-15deg);opacity:0;filter:drop-shadow(0 0 0px #3a9054)}60%{transform:scale(1.25) rotate(3deg);opacity:1;filter:drop-shadow(0 0 16px #3aad60)}100%{transform:scale(1) rotate(0);opacity:1;filter:drop-shadow(0 0 6px #3aad60)}}
@keyframes cubeOut{0%{transform:scale(1);opacity:1;filter:drop-shadow(0 0 6px var(--red-light))}40%{transform:scale(1.2);opacity:1;filter:drop-shadow(0 0 18px #ff4040)}100%{transform:scale(0) rotate(20deg);opacity:0;filter:drop-shadow(0 0 0px red)}}
@keyframes bottleStolen{0%{filter:drop-shadow(0 0 0 transparent)}30%{filter:drop-shadow(0 0 14px rgba(220,80,40,.9));transform:scale(1.1)}60%{filter:drop-shadow(0 0 22px rgba(220,80,40,.7));transform:scale(.85)}100%{filter:drop-shadow(0 0 0 transparent);transform:scale(1)}}
.bottle-anim{animation:bottleIn .55s cubic-bezier(.22,1,.36,1) forwards}
.cube-anim{animation:cubeOut .45s ease-in forwards}
.stolen-anim{animation:bottleStolen .6s ease-out forwards}

/* ── ROLL EXPLAIN BOX ── */
.roll-explain{background:rgba(0,0,0,.2);border:1px solid rgba(160,112,40,.2);border-radius:6px;padding:.4rem .7rem;font-style:italic;font-size:.82rem;color:var(--cream-dark);text-align:center;min-height:1.5rem}

/* ── PLAYER AREAS ── */
.player-area{background:linear-gradient(160deg,#1c1409,#160e06);border:1.5px solid var(--border);border-radius:11px;padding:.8rem .9rem .7rem;transition:border-color .4s,box-shadow .4s}
.player-area.active-turn{border-color:var(--gold);box-shadow:0 0 20px rgba(212,168,67,.18)}
.player-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:.6rem}
.pname{font-family:'Cinzel',serif;font-size:.88rem;color:var(--gold-light);font-weight:600;letter-spacing:.1em;display:flex;align-items:center;gap:.35rem}
.you-tag{font-size:.62rem;background:rgba(212,168,67,.12);border:1px solid rgba(212,168,67,.28);border-radius:4px;padding:.08rem .4rem;letter-spacing:.07em}
.supply-info{font-size:.82rem;color:var(--cream-dark);font-style:italic}
.stall{display:flex;gap:.42rem;flex-wrap:wrap;flex:0 0 auto}
.stall-slot{width:52px;height:74px;border:2px dashed rgba(140,95,30,.35);border-radius:8px;background:rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden;transition:all .3s}
.stall-slot.blocked{border:2px solid var(--red);background:rgba(90,20,20,.15)}
.stall-slot.filled{border:2px solid var(--green);background:rgba(30,80,45,.2);box-shadow:inset 0 0 9px rgba(40,100,60,.2)}
.slot-num{position:absolute;bottom:2px;right:4px;font-size:.54rem;font-family:'Cinzel',serif;opacity:.22;color:var(--cream)}
.red-cube{width:32px;height:32px;background:linear-gradient(145deg,#c03030 0%,#8a1818 60%,#4a0e0e 100%);border-radius:6px;box-shadow:2px 3px 6px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.12)}
.bottle-svg{display:block;width:26px;height:52px}
.bottle-placeholder{display:block;width:26px;height:52px;border-radius:3px 3px 5px 5px;background:rgba(42,112,64,.25);border:1.5px dashed rgba(42,112,64,.5);position:relative}
@keyframes deckShuffle{
  0%{transform:translateY(0) rotate(0deg);opacity:1}
  30%{transform:translateY(-6px) rotate(-8deg);opacity:.8}
  60%{transform:translateY(-4px) rotate(6deg);opacity:.9}
  100%{transform:translateY(0) rotate(0deg);opacity:1}
}
.deck-shuffling .deck-card-mini{animation:deckShuffle .5s ease-in-out forwards}
.deck-card-mini{width:8px;height:12px;border-radius:1px;background:linear-gradient(165deg,var(--wood-mid),var(--wood-dark));border:1px solid rgba(160,112,40,.4);transition:all .3s}
.hand-header{font-family:'IM Fell English',serif;font-style:italic;font-size:.78rem;color:var(--cream-dark);margin-bottom:.4rem;opacity:.8}
.hand-cards{display:flex;gap:.4rem;flex-wrap:wrap;min-height:64px;align-items:flex-start;max-width:480px}
.empty-hand{font-style:italic;color:rgba(200,184,136,.25);font-size:.78rem;align-self:center}

/* ── CARDS ── */
.card-wrap{position:relative}
.card{width:64px;height:90px;border-radius:7px;border:1.5px solid rgba(160,112,40,.5);display:flex;flex-direction:column;align-items:center;justify-content:center;user-select:none;overflow:visible;box-shadow:2px 3px 7px rgba(0,0,0,.5);transition:transform .18s,box-shadow .18s,border-color .18s;position:relative}
.card.face-up{background:linear-gradient(165deg,#e8d5a0 0%,#d4b878 55%,#c0a050 100%);cursor:pointer}
.card.face-up::before{content:'';position:absolute;inset:4px;border:1px solid rgba(140,100,30,.25);border-radius:4px;pointer-events:none}
.card.face-up:hover{transform:translateY(-4px);box-shadow:3px 6px 14px rgba(0,0,0,.6)}
.card.selected{border-color:var(--amber);transform:translateY(-8px);box-shadow:0 0 14px rgba(200,134,10,.5)}
.card.face-down{background:linear-gradient(165deg,#2e1a08 0%,#1e1006 60%,#100802 100%);cursor:default}
.card.face-down::after{content:'✦';color:var(--gold);font-size:1.4rem;opacity:.25}
.card-icon{font-size:1.55rem;line-height:1}
.card-name{font-family:'Cinzel',serif;font-size:.5rem;font-weight:600;text-align:center;margin-top:3px;letter-spacing:.06em;color:#1e0e00;padding:0 3px;line-height:1.2}
.card-divider{width:52%;height:1px;background:rgba(140,100,30,.35);margin:2px 0}
.card-desc-short{font-size:.42rem;text-align:center;padding:0 3px;color:#3a2200;font-style:italic;line-height:1.3}

.card-info-btn{position:absolute;top:2px;right:2px;width:14px;height:14px;border-radius:50%;background:rgba(158,32,32,.7);border:1px solid rgba(220,60,60,.6);color:#fff;font-size:.52rem;display:flex;align-items:center;justify-content:center;font-family:'Cinzel',serif;cursor:pointer;line-height:1;font-style:normal;font-weight:bold;z-index:2}
.card-info-btn:hover{background:rgba(200,40,40,.9)}
/* ── CARD TOOLTIP ── */
/* ── CARD INFO MODAL ── */
.card-info-inner{display:table;width:100%;border-collapse:separate;border-spacing:16px 0}
.card-info-art{display:table-cell;width:110px;vertical-align:top}
.card-info-art img{width:110px;display:block;border-radius:8px;border:1.5px solid var(--border-bright)}
.card-info-body{display:table-cell;vertical-align:top}
.card-info-name{font-family:'Cinzel',serif;font-size:1.1rem;color:var(--gold);letter-spacing:.12em;margin-bottom:.7rem;display:block}
.card-info-section{margin-bottom:.65rem;display:block}
.card-info-label{font-family:'Cinzel',serif;font-size:.65rem;color:var(--gold-light);letter-spacing:.1em;display:block;margin-bottom:.2rem}
.card-info-text{font-size:.88rem;color:var(--cream);line-height:1.5;display:block}
.card-info-flavor{font-style:italic;color:var(--cream-dark);font-size:.84rem;margin-top:.5rem;padding-top:.5rem;border-top:1px solid rgba(160,112,40,.2);display:block}

/* ── CENTER ── */
#center{background:linear-gradient(180deg,#201208 0%,#180e06 100%);border:1.5px solid rgba(140,95,30,.4);border-radius:11px;padding:.8rem .9rem;display:flex;flex-direction:column;align-items:center;gap:.55rem}
#status-box{background:rgba(0,0,0,.25);border:1px solid rgba(140,95,30,.3);border-radius:7px;padding:.4rem .8rem;font-family:'IM Fell English',serif;font-style:italic;font-size:.95rem;color:var(--cream);text-align:center;min-height:2rem;width:100%;line-height:1.4}
#dice-row{display:flex;gap:.36rem;justify-content:center;flex-wrap:wrap}
.die{width:46px;height:46px;background:linear-gradient(145deg,#e8d5a0 0%,#d4b870 50%,#c0a040 100%);border-radius:9px;box-shadow:3px 4px 8px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.55);display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(3,1fr);padding:5px;transition:background .3s,box-shadow .3s,transform .1s;position:relative}
.die.rolling{animation:shake .5s ease-in-out}
@keyframes shake{0%,100%{transform:rotate(0) scale(1)}20%{transform:rotate(-12deg) scale(1.08)}40%{transform:rotate(10deg) scale(.94)}60%{transform:rotate(-8deg) scale(1.06)}80%{transform:rotate(5deg) scale(.97)}}
/* Colour groups — each matching face value gets a distinct tint */
.die.grp-0{background:linear-gradient(145deg,#ffe8a0,#f5c830,#d4a010);box-shadow:0 0 14px rgba(240,192,40,.75)}
.die.grp-1{background:linear-gradient(145deg,#a8e6cf,#3aad70,#1d7a48);box-shadow:0 0 14px rgba(58,173,96,.7)}
.die.grp-2{background:linear-gradient(145deg,#f8b4c8,#e05080,#a02040);box-shadow:0 0 14px rgba(220,80,100,.7)}
.die.grp-3{background:linear-gradient(145deg,#b4d4f8,#4090e0,#2060a0);box-shadow:0 0 14px rgba(64,144,220,.7)}
.die.grp-4{background:linear-gradient(145deg,#e8c8f8,#a050d0,#6020a0);box-shadow:0 0 14px rgba(160,80,200,.7)}
.die.grp-5{background:linear-gradient(145deg,#ffd4a0,#e08030,#a04010);box-shadow:0 0 14px rgba(220,128,48,.7)}
/* Dots adapt to coloured backgrounds */
.die.grp-0 .dot,.die.grp-3 .dot,.die.grp-4 .dot{background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.4)}
.die.grp-1 .dot{background:#0a3a20;box-shadow:0 1px 3px rgba(0,0,0,.4)}
.die.grp-2 .dot,.die.grp-5 .dot{background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.4)}
.dot{width:7px;height:7px;background:#1a0f00;border-radius:50%;margin:auto;box-shadow:0 1px 2px rgba(0,0,0,.35)}
.dot.off{visibility:hidden}
/* Combo result cards */


/* ── DICE ROLL ANIMATION ── */
@keyframes dieFlip{0%{transform:rotateY(0) scale(1)}25%{transform:rotateY(90deg) scale(1.1)}50%{transform:rotateY(180deg) scale(1.04)}75%{transform:rotateY(270deg) scale(1.07)}100%{transform:rotateY(360deg) scale(1)}}
.die.rolling{animation:dieFlip .42s ease-out}

/* ── CARD DEAL ANIMATION ── */
@keyframes cardDeal{0%{opacity:0;transform:translateY(-16px) scale(.86)}60%{opacity:1;transform:translateY(3px) scale(1.04)}100%{opacity:1;transform:translateY(0) scale(1)}}
.card.deal-anim{animation:cardDeal .3s cubic-bezier(.22,1,.36,1) both}

/* ── STATUS PULSE on new message ── */
@keyframes statusPulse{0%{opacity:.5;transform:scaleX(.98)}100%{opacity:1;transform:scaleX(1)}}
.status-pulse{animation:statusPulse .28s ease-out}

/* ── COMBO ROW ── */
#combo-row{display:flex;gap:.5rem;flex-wrap:wrap;justify-content:center;min-height:20px}
.combo-card{display:flex;align-items:center;gap:.55rem;background:rgba(0,0,0,.25);border:1.5px solid rgba(160,112,40,.4);border-radius:10px;padding:.45rem .75rem;animation:comboIn .3s ease-out}
@keyframes comboIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.combo-card.c-double{border-color:rgba(212,168,67,.6)}
.combo-card.c-triple{border-color:rgba(58,173,96,.6)}
.combo-card.c-quad{border-color:rgba(200,80,80,.55)}
.combo-card.c-penta{border-color:rgba(220,80,220,.6);background:rgba(100,0,100,.2)}
.combo-icon{font-size:1.6rem;line-height:1;flex-shrink:0}
.combo-text{display:flex;flex-direction:column;gap:.1rem}
.combo-name{font-family:'Cinzel',serif;font-size:.68rem;letter-spacing:.1em;color:var(--gold-light)}
.combo-effect{font-size:.78rem;color:var(--cream);font-style:italic}

/* ── OVERLAY ── */
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.9);display:none;align-items:center;justify-content:center;z-index:200;backdrop-filter:blur(3px);padding:1rem;overflow-y:auto}
.overlay.open{display:flex}
.modal{background:linear-gradient(160deg,#2a1808 0%,#1c1005 50%,#120a02 100%);border:2px solid #c49030;border-radius:13px;padding:1.7rem 1.9rem;max-width:420px;width:92%;text-align:center;box-shadow:0 0 60px rgba(0,0,0,.85),inset 0 1px 0 rgba(196,144,48,.12);writing-mode:horizontal-tb!important;direction:ltr!important}
.modal *{writing-mode:horizontal-tb!important;direction:ltr!important}
.modal-icon{font-size:2.4rem;margin-bottom:.4rem}
.modal h2{font-family:'Cinzel',serif;font-size:1.65rem;color:var(--gold);margin-bottom:.6rem}
.modal p{color:var(--cream);font-size:1.2rem;line-height:1.5;margin-bottom:.9rem}
.modal .gold-line{margin:.6rem 0 .8rem}
.modal-btns{display:flex;gap:.5rem;justify-content:center;flex-wrap:wrap}
.blind-cards{display:flex;gap:.4rem;justify-content:center;flex-wrap:wrap;margin:.8rem 0}
.blind-card{width:58px;height:84px;border-radius:8px;border:1.5px solid var(--border);background:linear-gradient(165deg,var(--wood-mid),var(--wood-dark));cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--gold);font-size:1.4rem;transition:all .2s;opacity:.6}
.blind-card:hover{transform:translateY(-4px);border-color:var(--gold);opacity:1}

/* ── COMBO CHOICE ── */
.combo-choice-list{display:flex;flex-direction:column;gap:.5rem;margin:.7rem 0}
.combo-choice-btn{background:rgba(0,0,0,.2);border:1.5px solid var(--border);border-radius:9px;padding:.7rem 1rem;cursor:pointer;transition:all .2s;text-align:left}
.combo-choice-btn:hover{border-color:var(--gold);background:rgba(212,168,67,.08)}
.ccb-name{font-family:'Cinzel',serif;font-size:1.05rem;color:var(--gold-light);letter-spacing:.08em;margin-bottom:.25rem}
.ccb-desc{font-size:1rem;color:var(--cream-dark);font-style:italic;line-height:1.35}

/* ── WIN MODAL ── */
#win-modal.i-won{border-color:var(--green-light)}
#win-modal.i-won h2{color:var(--green-light)}
#win-modal.i-lost{border-color:var(--red-light)}
#win-modal.i-lost h2{color:#e87070}
/* Stats grid */
.stats-section{margin:.7rem 0;text-align:left}
.stats-title{font-family:'Cinzel',serif;font-size:.88rem;color:var(--gold-light);letter-spacing:.1em;margin-bottom:.5rem;text-align:center}
.stats-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:.4rem}
.stat-card{background:rgba(0,0,0,.2);border:1px solid rgba(160,112,40,.22);border-radius:8px;padding:.4rem .5rem;text-align:center}
.stat-val{font-family:'Cinzel',serif;font-size:1.65rem;color:var(--gold);font-weight:700;line-height:1}
.stat-label{font-size:.78rem;color:var(--cream-dark);margin-top:.2rem;font-style:italic;line-height:1.3}
.stats-compare{display:grid;grid-template-columns:1fr auto 1fr;gap:.3rem;align-items:center;margin:.5rem 0}
.stats-compare-col{display:flex;flex-direction:column;gap:.25rem}
.stats-compare-row{display:flex;align-items:center;gap:.3rem;font-size:.78rem}
.stats-compare-row.you{justify-content:flex-end;color:var(--gold-light)}
.stats-compare-row.opp{justify-content:flex-start;color:var(--cream-dark)}
.stats-compare-label{font-size:.8rem;color:var(--cream-dark);font-style:italic;text-align:center;align-self:center}
.stats-compare-val{font-family:'Cinzel',serif;font-weight:700;font-size:1rem;color:var(--gold)}
.stats-compare-val.opp{color:var(--cream-dark);font-size:1rem}
.stats-compare-divider{display:flex;flex-direction:column;gap:.25rem;align-items:center}
.stats-compare-mid{font-size:.78rem;color:rgba(200,184,136,.3);font-style:italic}

/* ── RECONNECT BANNER ── */
#reconnect-banner{position:fixed;top:0;left:0;right:0;z-index:300;background:rgba(90,50,5,.97);border-bottom:1.5px solid var(--amber);padding:.5rem 1rem;display:none;align-items:center;justify-content:center;gap:.8rem;font-family:'Cinzel',serif;font-size:.75rem;letter-spacing:.08em;color:var(--gold-light)}
#reconnect-banner.show{display:flex}
.reconnect-spinner{width:14px;height:14px;border:2px solid rgba(212,168,67,.3);border-top-color:var(--gold);border-radius:50%;animation:spin .8s linear infinite;flex-shrink:0}
@keyframes spin{to{transform:rotate(360deg)}}

/* ── MOBILE ── */
@media(max-width:680px){
  /* Layout */
  .header h1{font-size:1.6rem;letter-spacing:.18em}
  .header .tagline{font-size:.72rem}
  #screen-game{padding:.25rem}
  .game-layout{flex-direction:column;gap:.4rem}
  .game-main{gap:.35rem}

  /* Rules accordion on mobile — single column */
  .rules-cols{grid-template-columns:1fr}

  /* Player areas */
  .player-area{padding:.6rem .7rem .5rem}
  .pname{font-size:.82rem}
  .supply-info{font-size:.75rem}

  /* Stall + hand inline: smaller slots on mobile to fit side by side */
  .player-body{gap:.5rem}
  .stall{gap:.25rem}
  .stall-slot{width:44px;height:62px}
  .red-cube{width:26px;height:26px}
  .bottle-svg{width:20px;height:40px}

  /* Center / dice area */
  #center{padding:.6rem .5rem;gap:.4rem}
  #status-box{font-size:.9rem;padding:.35rem .6rem}
  .roll-explain{font-size:.76rem;padding:.3rem .5rem}

  /* Dice — bigger for touch */
  .die{width:50px;height:50px;border-radius:10px;padding:6px}
  .dot{width:8px;height:8px}
  #dice-row{gap:.3rem}

  /* Combo flash text */
  .flash-text{font-size:1.15rem}

  /* Combo cards */
  .combo-card{padding:.35rem .55rem;gap:.4rem}
  .combo-icon{font-size:1.3rem}
  .combo-name{font-size:.6rem}
  .combo-effect{font-size:.72rem}

  /* Cards — bigger touch targets */
  .card{width:64px;height:90px;border-radius:8px}
  .card-icon{font-size:1.6rem}
  .card-name{font-size:.5rem;margin-top:4px}
  .card-desc-short{font-size:.42rem}
  .hand-cards{gap:.3rem;min-height:64px}
  .card-info-btn{width:16px;height:16px;font-size:.55rem}

  /* Buttons — full width on mobile */
  .btn{font-size:.8rem;padding:.6rem 1.1rem}
  .btn-row{gap:.4rem}
  .btn-row .btn{flex:1;min-width:0}

  /* Lobby */
  .panel{padding:.9rem 1rem}
  .lobby-row{padding:.55rem .7rem}
  .lobby-num{font-size:.65rem;min-width:44px}

  /* Blind pick cards */
  .blind-card{width:52px;height:76px}

  /* Modal — fit screen on mobile */
  .overlay{align-items:flex-start;padding-top:env(safe-area-inset-top,12px)}
  .modal{padding:1rem 1.1rem;width:96%;max-height:92vh;overflow-y:auto}
  .modal h2{font-size:1.25rem;margin-bottom:.4rem}
  .modal p{font-size:.95rem;margin-bottom:.6rem}
  .modal-icon{font-size:1.8rem;margin-bottom:.2rem}
  .ccb-name{font-size:.88rem}
  .ccb-desc{font-size:.82rem}
  .combo-choice-list{gap:.35rem;margin:.4rem 0}

  /* Win stats grid */
  .stats-grid{grid-template-columns:1fr 1fr}
}

@media(max-width:380px){
  .stall-slot{width:38px;height:54px}
  .die{width:44px;height:44px}
  .card{width:58px;height:82px}
}
</style>
</head>
<body>

<div id="conn-bar"><div class="conn-dot wait" id="conn-dot"></div><span id="conn-label">Connecting…</span></div>
<div id="reconnect-banner"><div class="reconnect-spinner"></div><span id="reconnect-msg">Reconnecting…</span></div>
<div class="header"><h1>NINE OILS</h1><p class="tagline">a game of luck and will &nbsp;·&nbsp; by David Marques</p></div>

<!-- ══ NAME SCREEN ══ -->
<div class="screen active" id="screen-name" style="max-width:520px;margin:1rem auto">

  <!-- Video placeholder -->
  <div id="video-placeholder" style="width:100%;aspect-ratio:16/9;background:linear-gradient(160deg,#1a0e04,#0d0702);border:1.5px solid rgba(160,112,40,.3);border-radius:12px;margin-bottom:1rem;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.6rem;cursor:pointer;transition:border-color .2s" onclick="this.style.borderColor='var(--gold)'">
    <div style="width:56px;height:56px;border-radius:50%;background:rgba(196,144,48,.15);border:2px solid rgba(196,144,48,.4);display:flex;align-items:center;justify-content:center;font-size:1.6rem">▶</div>
    <div style="font-family:'Cinzel',serif;font-size:.78rem;letter-spacing:.12em;color:var(--cream-dark)">HOW TO PLAY</div>
    <div style="font-size:.7rem;color:rgba(200,184,136,.3);font-style:italic">Video coming soon</div>
  </div>

  <div class="panel">
    <h2>Welcome to the Fair</h2>
    <div class="name-form">
      <input class="name-input" id="name-input" type="text" maxlength="18" placeholder="Your vendor name…" autocomplete="off">
      <button class="btn" onclick="submitName()">Enter the Fair →</button>
    </div>
  </div>

  <!-- Credits footer -->
  <div id="credits-footer" style="text-align:center;margin-top:1.2rem;padding:.8rem 1rem;border-top:1px solid rgba(160,112,40,.15);font-size:.72rem;color:rgba(200,184,136,.35);line-height:1.8">
    <div style="font-family:'Cinzel',serif;letter-spacing:.1em;color:rgba(200,184,136,.5);margin-bottom:.3rem">NINE OILS</div>
    <div>Game design &amp; development &nbsp;&middot;&nbsp; <span style="color:rgba(200,184,136,.55)">David Marques</span></div>
    <div style="margin-top:.5rem;opacity:.5">v1.4 &nbsp;&middot;&nbsp; 2025</div>
  </div>

</div>

<!-- ══ LOBBY SCREEN ══ -->
<div class="screen" id="screen-lobby" style="max-width:560px;margin:.5rem auto">
  <div class="lobby-wrap">
    <div class="panel">
      <h2>Choose a Table</h2>
      <div class="lobby-list" id="lobby-list"></div>
      <div class="gold-line"></div>
      <div style="text-align:center;font-style:italic;font-size:.86rem;color:var(--cream-dark)">
        Playing as <strong id="lobby-name-display" style="color:var(--gold-light);font-style:normal"></strong>
      </div>
    </div>
  </div>
</div>

<!-- ══ WAITING SCREEN ══ -->
<div class="screen" id="screen-waiting" style="max-width:520px;margin:1rem auto">
  <div class="panel">
    <div class="waiting-box">
      <div class="big-icon">🎪</div>
      <h3>Setting up the Stall<span class="dots"></span></h3>
      <p id="waiting-text">Waiting for your opponent to join.</p>
      <p id="waiting-url" style="margin-top:.5rem;font-size:.78rem;opacity:.5"></p>
    </div>
    <div class="gold-line"></div>
    <div class="btn-row"><button class="btn danger sm" onclick="leaveLobby()">Leave Table</button></div>
  </div>
</div>

<!-- ══ GAME SCREEN ══ -->
<div class="screen" id="screen-game">
  <div class="game-layout">
    <div class="game-main">

      <!-- Opponent -->
      <div class="player-area" id="opp-area">
        <div class="player-header">
          <span class="pname" id="opp-name-label">Opponent</span>
          <span class="supply-info">Supply: <span id="opp-supply">6</span></span>
        </div>
        <div class="player-body">
          <div class="stall" id="opp-stall"></div>
          <div class="hand-col">
            <div class="hand-header">Their Hand</div>
            <div class="hand-cards" id="opp-hand"></div>
          </div>
        </div>
      </div>

      <!-- Center / Dice -->
      <div id="center">
        <div id="status-box">—</div>
        <div class="roll-explain" id="roll-explain"></div>
        <div id="dice-row"></div>
        <div id="combo-row"></div>
        <div class="btn-row" id="action-btns"></div>
        <div id="deck-counter" style="display:flex;align-items:center;justify-content:center;gap:.5rem;margin-top:.3rem;opacity:.6;font-size:.72rem;font-family:'Cinzel',serif;letter-spacing:.07em;color:var(--cream-dark)">
          <div id="deck-mini" style="display:flex;gap:2px;align-items:flex-end"></div>
          <span id="deck-count-label">— cards</span>
        </div>
      </div>

      <!-- Me -->
      <div class="player-area" id="my-area">
        <div class="player-header">
          <span class="pname" id="my-name-label">You <span class="you-tag">YOU</span></span>
          <span class="supply-info">Supply: <span id="my-supply">6</span></span>
        </div>
        <div class="player-body">
          <div class="stall" id="my-stall"></div>
          <div class="hand-col">
            <div class="hand-header">Your Hand</div>
            <div class="hand-cards" id="my-hand"></div>
          </div>
        </div>
      </div>

      <!-- Rules Accordion -->
      <div class="rules-accordion" id="rules-accordion">
        <button class="rules-accordion-toggle" onclick="toggleRules()">
          <span>📖 RULES &amp; REFERENCE</span>
          <span class="rules-accordion-caret">▼</span>
        </button>
        <div class="rules-accordion-body">
          <div class="rules-cols">
            <div>
              <div class="rules-section">
                <h3>🎯 Objective</h3>
                <div style="font-size:.74rem;color:var(--cream-dark);line-height:1.45">
                  Fill all <strong style="color:var(--cream)">6 slots</strong> in your stall with bottles. First to do it wins!
                </div>
              </div>
              <div class="rules-section">
                <h3>🎲 Dice Combos</h3>
                <div class="combo-entry"><div class="combo-name">DOUBLE</div><div class="combo-dice">Any 2 matching dice</div><div class="combo-effect">→ Draw 1 card</div></div>
                <div class="combo-entry"><div class="combo-name">TRIPLE + DOUBLE</div><div class="combo-dice">3 of one + 2 of another</div><div class="combo-effect">→ Stock 1 bottle</div></div>
                <div class="combo-entry"><div class="combo-name">QUAD</div><div class="combo-dice">4 of the same</div><div class="combo-effect">→ Remove 1 cube</div></div>
                <div class="combo-entry"><div class="combo-name">PENTA</div><div class="combo-dice">5 of the same</div><div class="combo-effect">→ Opponent discards hand</div></div>
                <div class="combo-entry"><div class="combo-name">SIX</div><div class="combo-dice">6 of the same</div><div class="combo-effect">→ Draw 3 cards</div></div>
                <div class="combo-entry"><div class="combo-name" style="color:#e8c84a">JOKER</div><div class="combo-dice">7 of the same</div><div class="combo-effect">→ Choose any previous combo</div></div>
                <div class="combo-entry" style="border-top:1px solid rgba(160,112,40,.3);margin-top:.4rem;padding-top:.4rem"><div class="combo-name" style="color:#e8c84a">EIGHT</div><div class="combo-dice">8 of the same</div><div class="combo-effect">→ Remove 2 cubes</div></div>
                <div class="combo-entry"><div class="combo-name" style="color:#e8c84a">NINE</div><div class="combo-dice">All 9 the same</div><div class="combo-effect">→ Instant win!</div></div>
                <div style="font-size:.71rem;color:var(--cream-dark);margin-top:.5rem;padding-top:.4rem;border-top:1px solid rgba(160,112,40,.2);line-height:1.45"><strong style="color:var(--cream)">Rule:</strong> One combo per face value per roll.</div>
              </div>
            </div>
            <div>
              <div class="rules-section">
                <h3>🃏 Your Turn</h3>
                <div style="font-size:.74rem;color:var(--cream-dark);line-height:1.5">1. Play any cards (optional)<br>2. Roll all 9 dice<br>3. Resolve all combos<br>4. Discard to 3 cards max</div>
              </div>
              <div class="rules-section">
                <h3>👤 Characters</h3>
                <div class="card-rule"><div class="card-rule-name">💃 The Temptress</div><div class="card-rule-text">Play before rolling. +1 bottle on Triple+Double. Two Temptresses = +2.</div></div>
                <div class="card-rule"><div class="card-rule-name">🤏 The Boy</div><div class="card-rule-text">Steals 1 bottle per card. Each Bully blocks 1 Boy.<br><span style="color:var(--cream-dark);font-size:.72rem">• 2 Boys vs 1 Bully → 1 stolen<br>• 2 Boys vs 0 Bullies → 2 stolen<br>• 1 Boy vs 1 Bully → blocked</span></div></div>
                <div class="card-rule"><div class="card-rule-name">👊 The Bully (I)</div><div class="card-rule-text">On opponent's turn — cancel one Boy attack.</div></div>
                <div class="card-rule"><div class="card-rule-name">👊 The Bully (II)</div><div class="card-rule-text">Play 2 Bullies on your turn — blindly discard 1 opponent card.</div></div>
              </div>
              <div class="rules-section">
                <h3>⚔️ Conflicts</h3>
                <div style="font-size:.74rem;color:var(--cream-dark);line-height:1.45">Same face → multiple combos? Choose one. Remaining dice of that face are discarded. No cascading.</div>
              </div>
            </div>
          </div>
        </div>
      </div>

    </div><!-- /game-main -->
  </div><!-- /game-layout -->
</div><!-- /screen-game -->

<!-- OVERLAYS -->
<div class="overlay" id="card-info-overlay">
  <div class="modal" style="max-width:520px;position:relative">
    <button onclick="closeOverlay('card-info-overlay')" style="position:absolute;top:.6rem;right:.7rem;background:rgba(0,0,0,.4);border:1px solid rgba(160,112,40,.4);border-radius:50%;width:28px;height:28px;color:#f2e4c0;font-size:1rem;cursor:pointer;line-height:1;font-family:serif;z-index:10;display:flex;align-items:center;justify-content:center">✕</button>
    <div id="card-info-content" style="overflow:hidden;min-height:200px"></div>
  </div>
</div>

<div class="overlay" id="boy-overlay">
  <div class="modal">
    <div class="modal-icon">🤏</div>
    <h2>Under Attack!</h2>
    <p id="boy-msg">Opponent plays Boys!</p>
    <div class="gold-line"></div>
    <div id="boy-bully-btns" style="display:flex;flex-direction:column;gap:.5rem;margin:.6rem 0"></div>
  </div>
</div>

<div class="overlay" id="blind-overlay">
  <div class="modal">
    <div class="modal-icon">👊</div>
    <h2>The Bully's Move</h2>
    <p id="blind-msg">Pick one card from your opponent's hand.</p>
    <div class="blind-cards" id="blind-cards"></div>
  </div>
</div>

<div class="overlay" id="discard-overlay">
  <div class="modal">
    <div class="modal-icon">🃏</div>
    <h2>Hand Limit</h2>
    <p>You're over the 3-card limit. Tap a card to discard it.</p>
    <div class="hand-cards" id="discard-hand" style="justify-content:center;margin:.7rem 0"></div>
    <p id="discard-hint" style="font-style:italic;color:var(--cream-dark);font-size:.84rem"></p>
  </div>
</div>

<div class="overlay" id="combo-overlay">
  <div class="modal">
    <div class="modal-icon">🎲</div>
    <h2>Choose Your Combo</h2>
    <p id="combo-overlay-msg">Your dice qualify for multiple combos. Which do you want to use?</p>
    <div class="combo-choice-list" id="combo-choice-list"></div>
  </div>
</div>

<div class="overlay" id="win-overlay">
  <div class="modal" id="win-modal" style="max-width:480px;text-align:center">
    <h2 id="win-title">You Win!</h2>
    <p id="win-msg">Six bottles stocked!</p>
    <div class="gold-line"></div>
    <div id="win-stats"></div>
    <div class="modal-btns" style="margin-top:.8rem">
      <button class="btn" onclick="send({type:'RESTART'})">Play Again</button>
      <button class="btn danger sm" onclick="leaveLobby()">Leave Table</button>
    </div>
  </div>
</div>

<div class="overlay" id="error-overlay">
  <div class="modal" style="border-color:var(--red-light)">
    <div class="modal-icon">⚠️</div>
    <h2 id="error-title" style="color:#e87070">Disconnected</h2>
    <p id="error-msg">Connection lost.</p>
    <div class="modal-btns"><button class="btn" onclick="location.reload()">Refresh</button></div>
  </div>
</div>

<script>
// ══ CARD TOOLTIP DATA ══════════════════════════════════════
const CARD_FULL = {
  TEMPTRESS:{
    icon:"💃", name:"The Temptress",
    when:"Play before rolling — any number on your turn.",
    effect:"If you roll a Triple+Double this turn, gain +1 extra bottle (2 total). Play both Temptress cards to gain +2 extra bottles (3 total).",
    flavor:"She knows how to draw a crowd.",
  },
  BOY:{
    icon:"🤏", name:"The Boy",
    when:"Play before rolling on your turn.",
    effect:"Steal 1 bottle from the opponent stall. If their stall is empty, the card does nothing. Your opponent may play a Bully to block. Play a second Boy to override a Bully defence.",
    flavor:"Quick hands. No conscience.",
  },
  BULLY:{
    icon:"👊", name:"The Bully",
    when:"Two uses — see below.",
    effect:"DEFENSIVE: on opponent turn, cancel a Boy attack. Both cards discarded. | OFFENSIVE: on your turn, play 2 Bullies together to blindly discard 1 card from the opponent hand.",
    flavor:"Not exactly a charmer, but effective.",
  },
};

const COMBO_INFO = {
  PENTA:        { label:'🎯 Penta',             desc:'Opponent discards their entire hand', detail:'5 dice showing the same value' },
  QUAD:         { label:'🔓 Quad',              desc:'Remove 1 red blocking cube from your stall', detail:'4 dice showing the same value' },
  TRIPLE_DOUBLE:{ label:'🍾 Triple + Double',   desc:'Stock 1 bottle (+ Temptress bonus if active)', detail:'3 of one value + 2 of another value' },
  DOUBLE:       { label:'🎲 Double',            desc:'Draw 1 Character card from the deck', detail:'Any 2 dice showing the same value' },
  SIX_OF_KIND:  { label:'🃏 Six of a Kind',     desc:'Draw 3 Character cards from the deck', detail:'6 dice showing the same value' },
  JOKER:        { label:'🃏 Joker',             desc:'Choose any previous combo (Double through Six)', detail:'7 dice showing the same value' },
  DOUBLE_QUAD:  { label:'🔓🔓 Eight of a Kind', desc:'Remove 2 red cubes instantly!', detail:'8 dice showing the same value' },
  INSTANT_WIN:  { label:'💀 Nine of a Kind',    desc:'Instant victory — an impossible feat!', detail:'All 9 dice showing the same value' },
};

const DOTS={1:[4],2:[2,6],3:[2,4,6],4:[0,2,6,8],5:[0,2,4,6,8],6:[0,2,3,5,6,8]};

// ══ STATE ══════════════════════════════════════════════════
let ws=null, myName='', myIdx=-1, state=null, lastDice=null;

// ── Name persistence ────────────────────────────────────
(function(){
  const saved = localStorage.getItem('nineoils_name');
  if(saved){ const inp=$('name-input'); if(inp) inp.value=saved; }
})();
let sessionToken=null;
let reconnectAttempts=0, reconnectTimer=null, intentionalLeave=false;
const MAX_RECONNECT=8, BASE_DELAY=1000;

// ══ WS ═════════════════════════════════════════════════════
function connect(){
  if(ws&&ws.readyState<2) ws.close();
  intentionalLeave=false;
  const proto=location.protocol==='https:'?'wss':'ws';
  try{ ws=new WebSocket(proto+'://'+location.host); }catch(e){scheduleReconnect();return;}

  let pingInterval=null;
  ws.onopen=()=>{
    setConn('ok','Connected');
    reconnectAttempts=0;
    clearTimeout(reconnectTimer);
    pingInterval=setInterval(()=>{ if(ws&&ws.readyState===1) send({type:'PING'}); },15000);
    // Try to restore session after reconnect
    const tok=sessionStorage.getItem('nine_oils_token');
    if(tok){
      sessionToken=tok;
      send({type:'RECONNECT',token:tok});
    } else {
      send({type:'LOBBIES'});
    }
  };

  ws.onmessage=e=>{
    try{ handleMsg(JSON.parse(e.data)); }catch(err){ console.warn('msg parse error',err); }
  };

  ws.onclose=e=>{
    clearInterval(pingInterval);
    if(intentionalLeave){ setConn('err','Left'); return; }
    setConn('wait','Reconnecting…');
    hideReconnectBanner(false);
    scheduleReconnect();
  };

  ws.onerror=()=>{};
}

function scheduleReconnect(){
  if(reconnectAttempts>=MAX_RECONNECT){
    setConn('err','Could not reconnect');
    showError('Connection Lost','Could not reconnect after '+MAX_RECONNECT+' attempts. Please refresh the page.');
    return;
  }
  const delay=Math.min(BASE_DELAY*Math.pow(1.5,reconnectAttempts),15000);
  reconnectAttempts++;
  setConn('wait','Reconnecting in '+(delay/1000).toFixed(0)+'s… (attempt '+reconnectAttempts+')');
  showReconnectBanner('Reconnecting… attempt '+reconnectAttempts+' of '+MAX_RECONNECT);
  reconnectTimer=setTimeout(connect, delay);
}

function send(msg){if(ws&&ws.readyState===1)ws.send(JSON.stringify(msg));}

// ── Rules accordion ─────────────────────────────────────
function toggleRules(){
  const el=document.getElementById('rules-accordion');
  if(el) el.classList.toggle('open');
}

// ── Reconnect on page visibility restore (fixes mobile scroll disconnect) ──
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'){
    if(!ws||ws.readyState===WebSocket.CLOSED||ws.readyState===WebSocket.CLOSING){
      reconnectAttempts=0;
      connect();
    }
  }
});

// ══ MESSAGES ═══════════════════════════════════════════════
function handleMsg(msg){
  switch(msg.type){
    case 'PONG': break;

    case 'RECONNECT_FAIL':
      // Session expired — go back to lobby selection
      sessionStorage.removeItem('nine_oils_token');
      sessionToken=null; state=null;
      hideReconnectBanner(true);
      showScreen('screen-lobby');
      send({type:'LOBBIES'});
      break;

    case 'RECONNECTED':
      myIdx=msg.seat;
      lastDice=null; // clear stale dice so next render shows correctly
      hideReconnectBanner(true);
      setConn('ok','Reconnected');
      // Request a fresh state after bot timers may have settled
      setTimeout(()=>send({type:'REQUEST_STATE'}), 800);
      // Game state will arrive via GAME_STATE shortly
      break;

    case 'OPPONENT_RECONNECTED':
      hideReconnectBanner(true);
      // Update status to show opponent is back
      if(state){ state.status=msg.name+' reconnected — game resumes!'; renderGame(); }
      break;

    case 'OPPONENT_DISCONNECTED_GRACE':
      // Show a gentle banner, not a fatal error
      showReconnectBanner(msg.name+' lost connection — waiting '+Math.round(msg.graceMs/1000)+'s for them to come back…');
      break;

    case 'LOBBIES':
      if(!state) renderLobbyList(msg.lobbies);
      break;

    case 'JOINED':
      myIdx=msg.seat;
      mySeat=msg.seat;
      if(msg.token){
        sessionToken=msg.token;
        sessionStorage.setItem('nine_oils_token',msg.token);
      }
      if(msg.solo){
        // Solo: don't show waiting screen, game state will arrive immediately
        showScreen('screen-game');
      } else {
        showScreen('screen-waiting');
        $('waiting-text').textContent='Waiting for your opponent to join…';
        $('waiting-url').textContent='Share: '+location.href;
      }
      break;

    case 'OPPONENT_JOINED':
      $('waiting-text').textContent=msg.name+' has joined! Starting…';
      break;


    case 'GAME_STATE':
      state=msg.state; myIdx=msg.state.myIdx;
      if(mySeat===null) mySeat=state.myIdx;
      hideReconnectBanner(true);
      showScreen('screen-game'); renderGame(); break;

    case 'OPPONENT_LEFT':
      closeAllOverlays();
      hideReconnectBanner(true);
      sessionStorage.removeItem('nine_oils_token');
      sessionToken=null; state=null;
      showError('Opponent Left','Your opponent left the table. The game has ended.');
      break;

    case 'ERROR':
      console.warn('Server error:',msg.text);
      break;
  }
}

// ══ NAME ═══════════════════════════════════════════════════
function submitName(){
  const v=$('name-input').value.trim();
  if(!v){$('name-input').focus();return;}
  myName=v;
  try{ localStorage.setItem('nineoils_name', myName); }catch(e){}
  $('lobby-name-display').textContent=myName;
  showScreen('screen-lobby');
  send({type:'LOBBIES'});
}
$('name-input').addEventListener('keydown',e=>{if(e.key==='Enter')submitName();});

// ══ LOBBY ══════════════════════════════════════════════════
function renderLobbyList(list){
  const el=$('lobby-list'); el.innerHTML='';
  list.forEach((l,idx)=>{
    if(l.solo){
      // Solo table — always available, special styling
      const row=document.createElement('div');
      row.className='lobby-row';
      row.style.cssText='border-color:rgba(212,168,67,.4);background:rgba(212,168,67,.06)';
      row.innerHTML=
        '<span class="lobby-num" style="color:var(--gold)">SOLO</span>'+
        '<span class="lobby-players" style="flex:1;font-style:italic;color:var(--gold-light);font-size:.85rem">🤖 vs The Peddler</span>'+
        '<span class="lobby-badge badge-open" style="color:var(--gold)">Always Open</span>';
      row.onclick=()=>joinLobby(l.id);
      el.appendChild(row);
      // Divider
      const div=document.createElement('div');
      div.style.cssText='height:1px;background:linear-gradient(90deg,transparent,rgba(160,112,40,.3),transparent);margin:.35rem 0';
      el.appendChild(div);
      return;
    }
    const full=l.players>=2&&l.status==='playing';
    const row=document.createElement('div');
    row.className='lobby-row'+(full?' disabled':'');
    row.innerHTML=
      '<span class="lobby-num">TABLE '+(idx)+'</span>'+
      '<span class="lobby-players" id="lp-'+l.id+'"></span>'+
      '<span class="lobby-badge '+( full?'badge-playing':l.players>0?'badge-waiting':'badge-open')+'">'+
        (full?'In Game':l.players>0?l.players+'/2 Waiting':'Open')+'</span>';
    if(!full) row.onclick=()=>joinLobby(l.id);
    el.appendChild(row);
  });
}

function joinLobby(id){
  send({type:'JOIN_LOBBY',lobbyId:id,playerName:myName});
  showScreen('screen-waiting');
}
function leaveLobby(){
  intentionalLeave=true;
  sessionStorage.removeItem('nine_oils_token');
  sessionToken=null; state=null; myIdx=-1;
  send({type:'LEAVE_LOBBY'});
  closeAllOverlays();
  hideReconnectBanner(true);
  showScreen('screen-lobby');
  send({type:'LOBBIES'});
}

// ══ GAME RENDER ════════════════════════════════════════════
let prevStalls = null;

function renderGame(){
  if(!state)return;
  const s=state;
  $('my-name-label').innerHTML=s.myName+' <span class="you-tag">YOU</span>';
  $('opp-name-label').textContent=s.oppName;
  $('my-supply').textContent=s.supplies[s.myIdx];
  $('opp-supply').textContent=s.supplies[1-s.myIdx];
  $('my-area').classList.toggle('active-turn',s.cur===s.myIdx);
  $('opp-area').classList.toggle('active-turn',s.cur!==s.myIdx);

  // Detect stall changes before re-rendering
  const myStall = s.stalls[s.myIdx];
  const oppStall = s.stalls[1-s.myIdx];
  const myChanges = prevStalls ? diffStall(prevStalls[0], myStall) : null;
  const oppChanges = prevStalls ? diffStall(prevStalls[1], oppStall) : null;
  prevStalls = [myStall.slice(), oppStall.slice()];

  renderStall('my-stall', myStall, myChanges);
  renderStall('opp-stall', oppStall, oppChanges);

  renderMyHand(s.myHand,s.phase,s.isMyTurn,s.sel);
  animateNewCards();
  renderOppHand(s.oppHandCount);
  $('status-box').textContent=s.status;
  pulseStatus(s.status);
  $('roll-explain').textContent=s.rollExplain?'You rolled: '+s.rollExplain:'';
  renderDeckCounter(s);
  renderDice(s.dice,s.combos||[]);
  renderComboBadges(s.combos||[],s.status);



  renderButtons(s);
  handleOverlays(s);
}

function diffStall(prev, next){
  // returns array of {idx, type:'bottle'|'cube_removed'|'stolen'}
  const changes=[];
  if(!prev) return changes;
  for(let i=0;i<next.length;i++){
    if(prev[i]===1 && next[i]===2) changes.push({idx:i, type:'bottle'});      // empty→filled
    else if(prev[i]===0 && next[i]===1) changes.push({idx:i, type:'cube_removed'}); // blocked→empty
    else if(prev[i]===2 && next[i]===1) changes.push({idx:i, type:'stolen'});  // filled→empty (stolen)
  }
  return changes;
}

function renderStall(id, slots, changes){
  const el=$(id); el.innerHTML='';
  slots.forEach((v,i)=>{
    const slot=document.createElement('div');
    slot.className='stall-slot'+(v===0?' blocked':v===2?' filled':'');
    const change = changes && changes.find(c=>c.idx===i);

    if(v===0){
      const c=document.createElement('div');c.className='red-cube';slot.appendChild(c);
    } else if(v===2){
      slot.innerHTML=bottleSVG();
      if(change && change.type==='bottle'){
        SFX.bottle();
        // New bottle — animate in
        slot.querySelector('svg').classList.add('bottle-anim');
        // Glow the slot border too
        slot.style.boxShadow='0 0 18px rgba(58,173,96,.8)';
        setTimeout(()=>{ if(slot.parentNode) slot.style.boxShadow=''; }, 900);
      } else if(change && change.type==='stolen'){
        SFX.steal();
        slot.querySelector('svg').classList.add('stolen-anim');
      }
    } else if(change && change.type==='cube_removed'){
      SFX.cube();
      const ghost=document.createElement('div');
      ghost.className='red-cube cube-anim';
      slot.appendChild(ghost);
      // Glow the slot
      slot.style.boxShadow='0 0 18px rgba(200,80,80,.8)';
      setTimeout(()=>{ if(slot.parentNode){ ghost.remove(); slot.style.boxShadow=''; }}, 480);
    }

    const n=document.createElement('span');n.className='slot-num';n.textContent=i+1;slot.appendChild(n);
    el.appendChild(slot);
  });
}

function renderMyHand(hand,phase,isMyTurn,sel){
  const el=$('my-hand'); el.innerHTML='';
  if(!hand.length){el.innerHTML='<span class="empty-hand">— no cards —</span>';return;}
  hand.forEach((card,i)=>{
    const wrap=document.createElement('div'); wrap.className='card-wrap';
    const c=makeCard(card,true);
    if(isMyTurn&&phase==='CARD_PLAY'){
      if(sel.includes(i))c.classList.add('selected');
      c.onclick=(e)=>{
        if(e.target.classList.contains('card-info-btn')){openCardInfo(card);return;}
        SFX.card();
      send({type:'SELECT_CARD',idx:i});
      };
    } else {
      c.onclick=(e)=>openCardInfo(card);
    }
    c.addEventListener('contextmenu',e=>{e.preventDefault();openCardInfo(card);});
    wrap.appendChild(c);
    wrap.appendChild(makeTooltip(card));
    el.appendChild(wrap);
  });
}

function renderOppHand(count){
  const el=$('opp-hand'); el.innerHTML='';
  if(!count){el.innerHTML='<span class="empty-hand">— no cards —</span>';return;}
  for(let i=0;i<count;i++) el.appendChild(makeCard(null,false));
}

function makeCard(type,faceUp){
  const d=document.createElement('div');
  d.className='card '+(faceUp?'face-up':'face-down');
  if(faceUp&&type){
    const info=CARD_FULL[type];
    d.innerHTML='<div class="card-icon">'+info.icon+'</div><div class="card-divider"></div><div class="card-name">'+info.name+'</div><div class="card-desc-short">'+info.effect.split('.')[0]+'</div><div class="card-info-btn" title="Card details">?</div>';
  }
  return d;
}

const CARD_IMGS={'TEMPTRESS':'/img/temptress.png','BOY':'/img/boy.png','BULLY':'/img/bully.png'};

function makeTooltip(type){
  // Returns a sentinel span — click triggers the card info modal
  const s = document.createElement('span');
  s.dataset.ttType = type;
  s.style.display = 'none';
  return s;
}

function openCardInfo(type){
  const info = CARD_FULL[type];
  if(!info) return;

  const el = $('card-info-content');
  el.innerHTML = '';

  // Use an iframe — 100% isolated from parent CSS, writing-mode can't reach in
  const frame = document.createElement('iframe');
  frame.setAttribute('style','border:none;width:100%;height:420px;display:block;background:transparent');
  frame.setAttribute('scrolling','no');
  el.appendChild(frame);

  const effectText = info.effect.split('|').map(function(s){return s.trim();}).join('<br><br>');
  const imgSrc = CARD_IMGS[type] ? location.origin + CARD_IMGS[type] : null;
  const imgTag = imgSrc
    ? '<img src="'+imgSrc+'" style="width:130px;height:auto;border-radius:7px;border:1.5px solid rgba(140,95,30,.5);display:block">'
    : '';

  const doc = frame.contentDocument || frame.contentWindow.document;
  doc.open();
  doc.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><style>'
    +'*{margin:0;padding:0;box-sizing:border-box;writing-mode:horizontal-tb;direction:ltr}'
    +'body{font-family:Georgia,serif;background:transparent;color:#f2e4c0;padding:4px 0}'
    +'table{border-collapse:collapse;width:100%}'
    +'td{vertical-align:top;padding:0}'
    +'.img-cell{width:124px;padding-right:14px}'
    +'.name{font-size:22px;color:#d4a843;font-weight:bold;margin-bottom:8px;line-height:1.3}'
    +'.hr{border:none;border-top:1px solid rgba(160,112,40,.45);margin:8px 0}'
    +'.label{font-size:13px;color:#edc96a;font-weight:bold;letter-spacing:.1em;text-transform:uppercase;margin-bottom:4px}'
    +'.body-text{font-size:18px;line-height:1.55;color:#f2e4c0;margin-bottom:10px}'
    +'.flavor{font-size:16px;font-style:italic;color:#c8b888;padding-top:8px;border-top:1px solid rgba(160,112,40,.25)}'
    +'</style></head><body>'
    +'<table><tr>'
    +'<td class="img-cell">'+imgTag+'</td>'
    +'<td>'
    +'<div class="name">'+info.name+'</div>'
    +'<hr class="hr">'
    +'<div class="label">When to Play</div>'
    +'<div class="body-text">'+info.when+'</div>'
    +'<div class="label">Effect</div>'
    +'<div class="body-text">'+effectText+'</div>'
    +'<div class="flavor">'+info.flavor+'</div>'
    +'</td>'
    +'</tr></table>'
    +'</body></html>');
  doc.close();

  // Resize iframe to content height after render
  setTimeout(function(){
    try{
      const h = doc.body.scrollHeight;
      if(h>80) frame.style.height = h+'px';
    }catch(e){}
  }, 50);

  openOverlay('card-info-overlay');
}

function renderWinStats(s){
  const el=$('win-stats'); if(!el||!s.stats)return;
  const me=s.stats[s.myIdx], opp=s.stats[1-s.myIdx];
  const bestCombo=function(st){
    if(st.combos.PENTA>0)return'PENTA';
    if(st.combos.QUAD>0)return'QUAD';
    if(st.combos.TRIPLE_DOUBLE>0)return'TRIPLE+DBL';
    if(st.combos.DOUBLE>0)return'DOUBLE';
    return'—';
  };
  const rows=[
    {label:'Turns',      me:me.turns,     opp:opp.turns,     text:false},
    {label:'Stocked',    me:me.stocked,   opp:opp.stocked,   text:false},
    {label:'Stolen',     me:me.stolen,    opp:opp.stolen,    text:false},
    {label:'Cards',      me:me.cards,     opp:opp.cards,     text:false},
    {label:'Best Combo', me:bestCombo(me),opp:bestCombo(opp),text:true},
  ];
  const numStyle='text-align:center;padding:.4rem .7rem;font-family:Cinzel,serif;font-size:1.7rem;color:var(--gold);font-weight:700;width:38%';
  const numStyleOpp='text-align:center;padding:.4rem .7rem;font-family:Cinzel,serif;font-size:1.7rem;color:var(--cream-dark);font-weight:700;width:38%';
  const txtStyle='text-align:center;padding:.4rem .7rem;font-family:Cinzel,serif;font-size:1rem;color:var(--gold);font-weight:700;width:38%';
  const txtStyleOpp='text-align:center;padding:.4rem .7rem;font-family:Cinzel,serif;font-size:1rem;color:var(--cream-dark);font-weight:700;width:38%';
  const midStyle='text-align:center;padding:.4rem .5rem;font-size:.8rem;color:var(--cream-dark);font-style:italic;white-space:nowrap;width:24%';
  let rowsHtml='';
  rows.forEach(function(r){
    const ms=r.text?txtStyle:numStyle;
    const os=r.text?txtStyleOpp:numStyleOpp;
    rowsHtml+='<tr><td style="'+ms+'">'+r.me+'</td><td style="'+midStyle+'">'+r.label+'</td><td style="'+os+'">'+r.opp+'</td></tr>';
  });
  const hdrStyle='font-family:Cinzel,serif;font-size:1rem;opacity:.7;padding:.2rem .7rem;text-align:center';
  el.innerHTML=
    '<div style="font-family:Cinzel,serif;font-size:1rem;color:var(--gold-light);letter-spacing:.1em;text-align:center;margin-bottom:.6rem">— Game Summary —</div>'+
    '<table style="width:100%;border-collapse:collapse;margin:0 auto;table-layout:fixed">'+
      '<thead><tr>'+
        '<th style="color:var(--gold-light);'+hdrStyle+'">'+s.myName+'</th>'+
        '<th style="width:24%"></th>'+
        '<th style="color:var(--cream-dark);'+hdrStyle+'">'+s.oppName+'</th>'+
      '</tr></thead>'+
      '<tbody>'+rowsHtml+'</tbody>'+
    '</table>';
}

function renderButtons(s){
  const el=$('action-btns'); el.innerHTML='';
  if(!s.isMyTurn){
    if(s.phase==='CARD_PLAY'||s.phase==='CHOOSE_COMBO'||s.phase==='ROLL_PAUSE')
      el.innerHTML='<span style="font-style:italic;color:var(--cream-dark);font-size:.88rem">Waiting for '+s.oppName+'…</span>';
    return;
  }
  if(s.phase==='ROLL_PAUSE'){
    const b=document.createElement('button');
    b.className='btn';
    b.innerHTML='▶ Continue';
    b.onclick=()=>{SFX.click();send({type:'CONTINUE'});};
    el.appendChild(b);
    return;
  }
  if(s.phase==='CARD_PLAY'){
    const b=document.createElement('button');
    b.className='btn';b.textContent=s.sel.length?'✔ Confirm Cards & Roll':'🎲 Roll Dice';
    b.onclick=()=>{
      SFX.click();
      b.disabled=true;
      b.textContent='Rolling…';
      b.style.opacity='.6';
      send({type:'ROLL'});
      // Safety resync: if server doesn't respond in 3s, re-enable and request fresh state
      setTimeout(()=>{
        if(b.disabled){
          b.disabled=false;
          b.style.opacity='';
          b.textContent='🎲 Roll Dice';
          send({type:'REQUEST_STATE'});
        }
      }, 3000);
    };
    el.appendChild(b);
    if(s.sel.length){
      const c=document.createElement('button');c.className='btn danger sm';c.textContent='✕ Clear';
      c.onclick=()=>[...s.sel].forEach(i=>send({type:'SELECT_CARD',idx:i}));el.appendChild(c);
    }
  }
}

// ══ OVERLAYS ═══════════════════════════════════════════════
function handleOverlays(s){
  // WIN
  if(s.winnerIdx!==null){
    const iWon=s.winnerIdx===s.myIdx;
    const wm=$('win-modal');
    wm.className='modal '+(iWon?'i-won':'i-lost');
    setTimeout(()=>iWon?SFX.win():SFX.lose(), 300);
    $('win-title').textContent=iWon?'🎉 You Win!':'You Lose!';
    $('win-msg').textContent=iWon
      ?'Six bottles stocked — you are the talk of the fair!'
      :s.oppName+' stocked 6 bottles first. Better luck next round!';
    renderWinStats(s);
    openOverlay('win-overlay');return;
  } else closeOverlay('win-overlay');

  // CHOOSE COMBO
  if(s.phase==='CHOOSE_COMBO'&&s.isMyTurn&&s.comboOptions){
    const explain=s.rollExplain?'You rolled: '+s.rollExplain+'. ':'';
    const isJoker=s.comboPickReason==='JOKER';
    $('combo-overlay-msg').textContent=isJoker
      ? explain+'🃏 Seven of a kind — the Joker! Choose any previous combo:'
      : explain+'These combos conflict — pick one:';
    const list=$('combo-choice-list'); list.innerHTML='';
    s.comboOptions.forEach(combo=>{
      const info=COMBO_INFO[combo];
      const btn=document.createElement('button');
      btn.className='combo-choice-btn';
      btn.innerHTML='<div class="ccb-name">'+info.label+'</div><div class="ccb-desc">'+info.detail+'<br><strong style="color:var(--cream)">→ '+info.desc+'</strong></div>';
      btn.onclick=()=>send({type:'CHOOSE_COMBO',combo});
      list.appendChild(btn);
    });
    openOverlay('combo-overlay');
  } else closeOverlay('combo-overlay');

  // BOY DEFEND — defender chooses how many Bullies to play (0 to min(bullies, boysAttacking))
  if(s.phase==='BOY_DEFEND'&&!s.isMyTurn){
    const attacks = s.boysAttacking || 1;
    const myBullies = s.myHand.filter(c=>c==='BULLY').length;
    const maxBlock = Math.min(myBullies, attacks);
    $('boy-msg').textContent = s.oppName + ' plays ' + attacks + ' Boy' + (attacks>1?'s':'') + '! You have ' + myBullies + ' Bull' + (myBullies===1?'y':'ies') + '.';
    const btns = $('boy-bully-btns'); btns.innerHTML = '';
    // One button per possible number of bullies to play (max down to 0)
    for(let b = maxBlock; b >= 0; b--){
      const btn = document.createElement('button');
      btn.className = b > 0 ? 'btn' : 'btn danger';
      if(b === 0) {
        const stolen = attacks;
        const short = 'Take hit (' + stolen + ' stolen)';
        const long  = 'Take the Hit (' + stolen + ' bottle' + (stolen>1?'s':'') + ' stolen)';
        btn.textContent = window.innerWidth < 480 ? short : long;
      } else {
        const remaining = attacks - b;
        const shortT = 'Block ' + b + (remaining > 0 ? ' (' + remaining + ' stolen)' : ' — blocked!');
        const longT  = 'Block ' + b + ' with Bull' + (b===1?'y':'ies') + (remaining > 0 ? ' (' + remaining + ' still stolen)' : ' — fully blocked!');
        btn.textContent = window.innerWidth < 480 ? shortT : longT;
      }
      const captured = b;
      btn.onclick = () => send({type:'BOY_DEFEND', bulliesPlayed: captured});
      btns.appendChild(btn);
    }
    openOverlay('boy-overlay');
  } else closeOverlay('boy-overlay');

  // BLIND PICK
  if(s.phase==='BLIND_PICK'&&s.isMyTurn){
    $('blind-msg').textContent='Pick one from '+s.oppName+"'s hand ("+s.oppHandCount+' cards):';
    const bc=$('blind-cards');bc.innerHTML='';
    for(let i=0;i<s.oppHandCount;i++){
      const el=document.createElement('div');el.className='blind-card';el.innerHTML='✦';
      el.onclick=()=>send({type:'BLIND_PICK',cardIdx:i});bc.appendChild(el);
    }
    openOverlay('blind-overlay');
  } else closeOverlay('blind-overlay');

  // DISCARD
  if(s.phase==='DISCARD'&&s.isMyTurn){
    const excess=s.myHand.length-3;
    $('discard-hint').textContent='Discard '+excess+' card'+(excess>1?'s':'')+'.';
    const dh=$('discard-hand');dh.innerHTML='';
    s.myHand.forEach((card,i)=>{
      const wrap=document.createElement('div');wrap.className='card-wrap';
      const el=makeCard(card,true);
      el.onclick=()=>send({type:'DISCARD',cardIdx:i});
      wrap.appendChild(el);wrap.appendChild(makeTooltip(card));dh.appendChild(wrap);
    });
    openOverlay('discard-overlay');
  } else closeOverlay('discard-overlay');
}

// ══ DICE ═══════════════════════════════════════════════════
function initDice(){
  const el=$('dice-row');el.innerHTML='';
  for(let i=0;i<9;i++){
    const d=document.createElement('div');d.className='die';d.id='die-'+i;
    for(let c=0;c<9;c++){const dot=document.createElement('div');dot.className='dot off';d.appendChild(dot);}
    el.appendChild(d);
  }
}

function renderDice(dice,combos){
  const changed=JSON.stringify(dice)!==JSON.stringify(lastDice);
  if(changed && dice.some(d=>d>0)) SFX.roll();
  lastDice=dice;

  // Build frequency map and assign a colour group index to each face value (only for groups >=2)
  const freq={};
  dice.forEach(d=>freq[d]=(freq[d]||0)+1);
  // Sort by count desc so bigger groups get lower (more prominent) group index
  const groupMap={}; // faceValue -> groupIndex
  let gi=0;
  Object.entries(freq)
    .filter(([,c])=>c>=2)
    .sort((a,b)=>b[1]-a[1])
    .forEach(([v])=>{ groupMap[v]=gi++; });

  dice.forEach((val,i)=>{
    const die=document.getElementById('die-'+i);if(!die)return;
    for(let g=0;g<6;g++) die.classList.remove('grp-'+g);

    if(changed && dice.some(d=>d>0)){
      // Animate: flash random dots during roll, then settle on real value
      die.classList.add('rolling');
      let flips=0;
      const flipInterval=setInterval(()=>{
        const fake=Math.ceil(Math.random()*6);
        const fakeOn=DOTS[fake]||[];
        die.querySelectorAll('.dot').forEach((d,c)=>d.className='dot'+(fakeOn.includes(c)?'':' off'));
        if(++flips>=5) clearInterval(flipInterval);
      },60);
      setTimeout(()=>{
        die.classList.remove('rolling');
        // Settle on real value
        const on=DOTS[val]||[];
        die.querySelectorAll('.dot').forEach((d,c)=>d.className='dot'+(on.includes(c)?'':' off'));
        if(groupMap[val]!==undefined) die.classList.add('grp-'+groupMap[val]);
      }, 420);
    } else {
      const on=DOTS[val]||[];
      die.querySelectorAll('.dot').forEach((d,c)=>d.className='dot'+(on.includes(c)?'':' off'));
      if(groupMap[val]!==undefined) die.classList.add('grp-'+groupMap[val]);
    }
  });
}

function renderComboBadges(combos, statusText){
  const el=$('combo-row');el.innerHTML='';
  if(!combos||!combos.length) return;
  // Sound based on best combo
  if(combos.includes('INSTANT_WIN')) SFX.win();
  else if(combos.includes('PENTA')) SFX.penta();
  else if(combos.length) SFX.combo();

  // Parse how many bottles were stocked from the status text
  const bottleMatch = statusText && statusText.match(/(\d+) bottle/);
  const bottleCount = bottleMatch ? +bottleMatch[1] : 1;

  const COMBO_CARDS = {
    INSTANT_WIN:{
      cls:'c-penta', name:'NINE OF A KIND',
      icon:'💀',
      effect:'Instant victory — an impossible feat!'
    },
    DOUBLE_QUAD:{
      cls:'c-quad', name:'EIGHT OF A KIND',
      icon:'🔓🔓',
      effect:'Two cubes removed instantly!'
    },
    SIX_OF_KIND:{
      cls:'c-double', name:'SIX OF A KIND',
      icon:'🃏',
      effect:'Drew 3 Character cards!'
    },
    PENTA:{
      cls:'c-penta', name:'PENTA',
      icon:'💥',
      effect:'Opponent discards entire hand!'
    },
    QUAD:{
      cls:'c-quad', name:'QUAD',
      icon:'🔓',
      effect:'Red cube removed — slot opened!'
    },
    TRIPLE_DOUBLE:{
      cls:'c-triple', name:'TRIPLE + DOUBLE',
      icon: bottleCount>1 ? '🍾🍾' : '🍾',
      effect: bottleCount>1 ? bottleCount+' bottles stocked!' : '1 bottle stocked!'
    },
    DOUBLE:{
      cls:'c-double', name:'DOUBLE',
      icon:'🃏',
      effect:'Drew a Character card'
    },
  };

  // Show in impact order
  ['INSTANT_WIN','DOUBLE_QUAD','SIX_OF_KIND','JOKER','PENTA','QUAD','TRIPLE_DOUBLE','DOUBLE'].forEach(key=>{
    if(!combos.includes(key)) return;
    const info=COMBO_CARDS[key];
    const card=document.createElement('div');
    card.className='combo-card '+info.cls;
    card.innerHTML=
      '<div class="combo-icon">'+info.icon+'</div>'+
      '<div class="combo-text">'+
        '<div class="combo-name">'+info.name+'</div>'+
        '<div class="combo-effect">'+info.effect+'</div>'+
      '</div>';
    el.appendChild(card);
  });
}



function bottleSVG(){
  // Original artwork: potion-svgrepo-com.svg (svgrepo.com) — adapted to 26×52px
  return '<svg class="bottle-svg" width="26" height="52" viewBox="0 0 512 512" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">'
    + '<polygon style="fill:#F58E42;" points="348.596,8.17 337.702,73.532 256,106.213 174.298,73.532 163.404,8.17"/>'
    + '<path style="fill:#7B2FA8;" d="M413.957,236.936v234.213c0,17.974-14.706,32.681-32.681,32.681H130.723c-17.974,0-32.681-14.706-32.681-32.681V236.936c0-35.949,29.413-65.362,65.362-65.362V95.319h185.191v76.255C384.545,171.574,413.957,200.987,413.957,236.936z"/>'
    + '<path style="fill:#5C1A85;" d="M348.596,73.532c9.02,0,16.34,7.321,16.34,16.34s-7.32,16.34-16.34,16.34H163.404c-9.02,0-16.34-7.321-16.34-16.34c0-4.51,1.83-8.595,4.793-11.547c2.952-2.963,7.037-4.793,11.547-4.793h10.894h163.404H348.596z"/>'
    + '<polygon style="fill:#F1ECDE;" points="381.277,405.787 381.277,438.468 130.723,438.468 130.723,269.617 163.404,269.617 179.745,280.511 196.085,269.617 381.277,269.617 381.277,373.106 370.383,389.447"/>'
    + '<circle style="fill:#A59D8C;" cx="312.778" cy="362.213" r="8.17"/>'
    + '<circle style="fill:#A59D8C;" cx="285.543" cy="384" r="8.17"/>'
    + '<circle style="fill:#A59D8C;" cx="199.212" cy="324.085" r="8.17"/>'
    + '<path style="fill:#2a0840;" d="M356.766,163.855v-50.878c9.509-3.373,16.34-12.455,16.34-23.105c0-13.515-10.995-24.511-24.511-24.511h-1.248l9.308-55.848c0.394-2.369-0.272-4.792-1.825-6.624C353.278,1.057,350.998,0,348.596,0H163.404c-2.402,0-4.682,1.057-6.234,2.889c-1.552,1.832-2.22,4.255-1.825,6.624l9.308,55.848h-1.248c-13.516,0-24.511,10.996-24.511,24.511c0,10.651,6.831,19.733,16.34,23.105v50.878c-36.715,4.077-65.362,35.296-65.362,73.081v234.213c0,22.526,18.325,40.851,40.851,40.851h250.553c22.526,0,40.851-18.325,40.851-40.851V236.936C422.128,199.152,393.481,167.933,356.766,163.855z M173.049,16.34h165.902l-8.17,49.021H181.22L173.049,16.34z M405.787,471.149c0,13.515-10.995,24.511-24.511,24.511H130.723c-13.516,0-24.511-10.996-24.511-24.511V236.936c0-31.535,25.656-57.191,57.191-57.191c4.512,0,8.17-3.657,8.17-8.17v-57.191h24.511c4.512,0,8.17-3.657,8.17-8.17s-3.658-8.17-8.17-8.17h-32.681c-4.506,0-8.17-3.665-8.17-8.17s3.665-8.17,8.17-8.17h174.295c0.037,0,10.897,0,10.897,0c4.506,0,8.17,3.665,8.17,8.17s-3.665,8.17-8.17,8.17h-119.83c-4.512,0-8.17,3.657-8.17,8.17s3.658,8.17,8.17,8.17h111.66v57.191c0,4.513,3.658,8.17,8.17,8.17c31.536,0,57.191,25.657,57.191,57.191V471.149z"/>'
    + '<path style="fill:#2a0840;" d="M196.085,179.745h119.83c4.512,0,8.17-3.657,8.17-8.17s-3.658-8.17-8.17-8.17h-119.83c-4.512,0-8.17,3.657-8.17,8.17S191.573,179.745,196.085,179.745z"/>'
    + '<path style="fill:#2a0840;" d="M381.277,261.447H196.085c-1.612,0-3.19,0.477-4.532,1.373l-11.809,7.872l-11.809-7.873c-1.342-0.894-2.919-1.373-4.532-1.373h-32.681c-4.512,0-8.17,3.657-8.17,8.17v168.851c0,4.513,3.658,8.17,8.17,8.17h250.553c4.512,0,8.17-3.657,8.17-8.17v-32.681c0-1.612-0.477-3.191-1.373-4.532l-7.873-11.809l7.873-11.809c0.894-1.341,1.373-2.919,1.373-4.532V269.616C389.447,265.104,385.789,261.447,381.277,261.447z M373.106,370.632l-9.521,14.281c-1.83,2.745-1.83,6.319,0,9.064l9.521,14.282v22.039H138.894V277.787h22.037l14.283,9.521c2.745,1.83,6.319,1.83,9.064,0l14.283-9.521h174.547V370.632z"/>'
    + '</svg>';
}

function $(id){return document.getElementById(id);}
function setConn(s,l){$('conn-dot').className='conn-dot '+s;$('conn-label').textContent=l;}
function showScreen(id){document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));$(id).classList.add('active');}
function openOverlay(id){$(id).classList.add('open');}
function closeOverlay(id){$(id).classList.remove('open');}
function closeAllOverlays(){document.querySelectorAll('.overlay').forEach(o=>o.classList.remove('open'));}
function showError(t,m){closeAllOverlays();$('error-title').textContent=t;$('error-msg').textContent=m;openOverlay('error-overlay');}

function showReconnectBanner(msg){
  $('reconnect-banner').classList.add('show');
  $('reconnect-msg').textContent=msg;
}
function hideReconnectBanner(fully){
  if(fully) $('reconnect-banner').classList.remove('show');
  else $('reconnect-msg').textContent='Reconnecting…';
}

initDice();
connect();
function escHtml(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── Deck counter ─────────────────────────────────────────
let _lastDeckRemaining = -1;
function renderDeckCounter(s){
  const total = s.deckCount || 0;
  const remaining = s.deckRemaining !== undefined ? s.deckRemaining : total;
  const lbl = $('deck-count-label');
  const mini = $('deck-mini');
  if(!lbl||!mini) return;

  // Reshuffle animation: remaining was near 0, now jumped back up
  if(_lastDeckRemaining >= 0 && _lastDeckRemaining <= 2 && remaining > 4){
    mini.classList.add('deck-shuffling');
    setTimeout(()=>mini.classList.remove('deck-shuffling'), 600);
  }
  _lastDeckRemaining = remaining;

  lbl.textContent = remaining + ' card' + (remaining!==1?'s':'') + ' in deck';

  // Mini card stack — show up to 5 cards visually
  mini.innerHTML = '';
  const shown = Math.min(5, Math.ceil(remaining / Math.max(1, total) * 5));
  for(let i=0;i<shown;i++){
    const c = document.createElement('div');
    c.className = 'deck-card-mini';
    c.style.transform = 'translateY(' + (-i*1.5) + 'px)';
    c.style.opacity = remaining === 0 ? '0.2' : '1';
    mini.appendChild(c);
  }
  if(remaining === 0){
    lbl.textContent = 'Deck empty — reshuffling soon';
    lbl.style.color = 'rgba(200,120,80,.6)';
  } else {
    lbl.style.color = '';
  }
}
let lastStatusText = '';
function pulseStatus(text){
  const el = $('status-box'); if(!el) return;
  if(text !== lastStatusText){
    lastStatusText = text;
    el.classList.remove('status-pulse');
    void el.offsetWidth; // reflow
    el.classList.add('status-pulse');
    el.addEventListener('animationend', ()=>el.classList.remove('status-pulse'), {once:true});
  }
}

let prevHandCount = -1;
function animateNewCards(){
  // Briefly add deal-anim to cards that just appeared
  const cards = document.querySelectorAll('#my-hand .card.face-up');
  const count = cards.length;
  if(count > prevHandCount && prevHandCount >= 0){
    // Only animate the new ones (last N)
    const newCount = count - prevHandCount;
    const toAnim = Array.from(cards).slice(-newCount);
    toAnim.forEach((c,i)=>{
      setTimeout(()=>{
        c.classList.add('deal-anim');
        c.addEventListener('animationend',()=>c.classList.remove('deal-anim'),{once:true});
      }, i*60);
    });
  }
  prevHandCount = count;
}

// ══ SOUND FX (Web Audio API — no files needed) ══════════════
const SFX = (function(){
  let ctx = null;
  function ac(){
    if(!ctx) ctx = new (window.AudioContext||window.webkitAudioContext)();
    if(ctx.state==='suspended') ctx.resume();
    return ctx;
  }
  function osc(freq, type, dur, vol, attack, decay){
    const c=ac(), o=c.createOscillator(), g=c.createGain();
    o.connect(g); g.connect(c.destination);
    o.type=type||'sine'; o.frequency.setValueAtTime(freq,c.currentTime);
    g.gain.setValueAtTime(0,c.currentTime);
    g.gain.linearRampToValueAtTime(vol||0.3, c.currentTime+(attack||0.01));
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime+(dur||0.3));
    o.start(c.currentTime); o.stop(c.currentTime+(dur||0.3)+(decay||0));
  }
  function noise(dur, vol){
    const c=ac(), buf=c.createBuffer(1,c.sampleRate*dur,c.sampleRate);
    const d=buf.getChannelData(0);
    for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1);
    const s=c.createBufferSource(), g=c.createGain();
    s.buffer=buf; s.connect(g); g.connect(c.destination);
    g.gain.setValueAtTime(vol||0.15, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime+dur);
    s.start();
  }
  return {
    roll: function(){
      // Dice rattling — rapid noise bursts
      for(let i=0;i<6;i++) setTimeout(()=>noise(0.06, 0.12), i*55);
      setTimeout(()=>noise(0.12, 0.18), 330);
    },
    bottle: function(){
      // Satisfying glass clink — two harmonics
      osc(880,'sine',0.5,0.25,0.005);
      setTimeout(()=>osc(1320,'sine',0.4,0.15,0.005), 30);
      setTimeout(()=>osc(660,'sine',0.3,0.1,0.005), 80);
    },
    steal: function(){
      // Sneaky descending slide
      const c=ac(), o=c.createOscillator(), g=c.createGain();
      o.connect(g); g.connect(c.destination);
      o.type='sawtooth';
      o.frequency.setValueAtTime(600, c.currentTime);
      o.frequency.exponentialRampToValueAtTime(200, c.currentTime+0.3);
      g.gain.setValueAtTime(0.18, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime+0.35);
      o.start(); o.stop(c.currentTime+0.4);
    },
    cube: function(){
      // Heavy thud — low thump
      const c=ac(), o=c.createOscillator(), g=c.createGain();
      o.connect(g); g.connect(c.destination);
      o.type='sine';
      o.frequency.setValueAtTime(120, c.currentTime);
      o.frequency.exponentialRampToValueAtTime(40, c.currentTime+0.2);
      g.gain.setValueAtTime(0.4, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime+0.25);
      o.start(); o.stop(c.currentTime+0.3);
    },
    combo: function(){
      // Ascending fanfare — three notes
      [0,150,320].forEach((t,i)=>{
        const freqs=[[440,554,659],[494,622,740],[523,659,784]];
        freqs[i].forEach((f,j)=>setTimeout(()=>osc(f,'sine',0.35,0.12,0.01), j*30));
      });
    },
    penta: function(){
      // Big dramatic hit
      noise(0.08, 0.3);
      [220,277,330,415,523].forEach((f,i)=>setTimeout(()=>osc(f,'sawtooth',0.5,0.15,0.01), i*40));
    },
    win: function(){
      // Victory fanfare
      const melody=[523,659,784,1047];
      melody.forEach((f,i)=>setTimeout(()=>osc(f,'sine',0.5,0.2,0.02), i*150));
      setTimeout(()=>osc(1047,'sine',1.0,0.25,0.02), 600);
    },
    lose: function(){
      // Sad trombone-ish
      const notes=[440,415,392,349];
      notes.forEach((f,i)=>setTimeout(()=>osc(f,'sawtooth',0.45,0.15,0.02), i*180));
    },
    click: function(){
      osc(800,'sine',0.06,0.08,0.002);
    },
    card: function(){
      // Card whoosh
      noise(0.05, 0.08);
      setTimeout(()=>osc(400,'triangle',0.08,0.06,0.005), 20);
    },
  };
})();

</script>
</body>
</html>`;
