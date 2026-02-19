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

  const tripleEntry=entries.find(e=>e.c>=3);
  const dblEntry=tripleEntry?entries.find(e=>e.c>=2&&e.v!==tripleEntry.v):null;
  const hasTripleDouble=!!(tripleEntry&&dblEntry);

  // Build set of primary options (the ones that share dice and can conflict)
  const primary=[];
  if(max>=5) primary.push('PENTA');
  if(max>=4) primary.push('QUAD');
  if(hasTripleDouble) primary.push('TRIPLE_DOUBLE');

  // DOUBLE is available if there's a pair NOT consumed by a chosen primary
  // We compute this per-choice later; for now flag whether it's structurally possible
  const hasDouble=max>=2;

  if(primary.length<=1){
    // No conflict - auto-resolve everything
    const combos=[...primary];
    if(hasDouble && canDoubleCoexist(dice,primary[0])) combos.push('DOUBLE');
    return {conflict:false, combos, freq};
  }
  // Conflict: player must choose
  return {conflict:true, primary, hasDouble, freq};
}

function canDoubleCoexist(dice,chosenPrimary){
  // After consuming dice for chosen combo, is there still a pair left?
  const freq={};
  dice.forEach(d=>freq[d]=(freq[d]||0)+1);
  const entries=Object.entries(freq).map(([v,c])=>({v:+v,c})).sort((a,b)=>b.c-a.c);
  const used={};

  if(chosenPrimary==='PENTA'){
    const pv=entries.find(e=>e.c>=5); if(pv) used[pv.v]=5;
  } else if(chosenPrimary==='QUAD'){
    const qv=entries.find(e=>e.c>=4); if(qv) used[qv.v]=4;
  } else if(chosenPrimary==='TRIPLE_DOUBLE'){
    const tv=entries.find(e=>e.c>=3); if(tv) used[tv.v]=3;
    const dv=tv?entries.find(e=>e.c>=2&&e.v!==tv.v):null; if(dv) used[dv.v]=2;
  } else if(!chosenPrimary){
    // No primary chosen — pair is just any pair
    return Object.values(freq).some(c=>c>=2);
  }

  // Check remaining dice for a pair
  for(const [v,c] of Object.entries(freq)){
    const left=c-(used[+v]||0);
    if(left>=2) return true;
  }
  return false;
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
  };
  const c0=dealCard(g);if(c0)g.players[0].hand.push(c0);
  const c1=dealCard(g);if(c1)g.players[1].hand.push(c1);
  g.status=`A mysterious ailment strikes the crowd… ${g.players[g.cur].name} goes first!`;
  return g;
}

function buildView(g,seat){
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
    combos:g.combos,
    comboOptions:g.comboOptions,
    rollExplain:g.rollExplain,
    sel:g.cur===seat?g.sel:[],
    winnerIdx:g.winnerIdx,
    isSolo:g.isSolo,
    stats:g.stats,
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
    if(lobby2.solo&&lobby2.game.cur===1) setTimeout(()=>botTurn(lobby2),1800);
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
      if(g.cur!==seat||g.phase!=='CARD_PLAY')return;
      processCardPlays(lobby); break;

    case 'CHOOSE_COMBO':
      if(g.cur!==seat||g.phase!=='CHOOSE_COMBO')return;
      resolveChosenCombo(lobby,msg.combo); break;

    case 'BOY_DEFEND':
      if(g.phase!=='BOY_DEFEND'||seat!==1-g.cur)return;
      if(msg.defend){
        const bi=g.players[seat].hand.indexOf('BULLY');
        if(bi>=0){g.players[seat].hand.splice(bi,1);trash(g,'BULLY');g.stats[seat].cards++;}
        g.status=`${g.players[seat].name} plays the Bully! The theft is stopped.`;
      } else doSteal(g);
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
    for(let b=0;b<bullies;b++) trash(g,'BULLY');
    if(opp.hand.length>0){
      g.phase='BLIND_PICK';
      g.status=`${p.name} plays 2 Bullies! Pick a card blindly from ${opp.name}'s hand.`;
      broadcastGame(lobby);
      if(g.isSolo&&g.cur===1) setTimeout(()=>botTurn(lobby),1400);
      return;
    }
    g.status=`The Bullies flex — but ${opp.name} has an empty hand!`;
    rollAndResolve(lobby); return;
  }
  for(let b=0;b<bullies;b++) trash(g,'BULLY');
  if(boys>0){
    for(let b=0;b<boys;b++) trash(g,'BOY');
    if(!opp.stall.find(s=>s===2)&&opp.stall.filter(s=>s===2).length===0){
      g.status=`The Boy reaches out — ${opp.name}'s stall is bare!`;
      rollAndResolve(lobby); return;
    }
    if(boys>=2){doSteal(g);rollAndResolve(lobby);return;}
    if(opp.hand.includes('BULLY')){
      g.phase='BOY_DEFEND';
      g.status=`${p.name} plays The Boy! ${opp.name}, defend with a Bully?`;
      broadcastGame(lobby);
      // If bot is defending
      if(g.isSolo&&1-g.cur===1) setTimeout(()=>botDefend(lobby),1400);
      return;
    }
    doSteal(g); rollAndResolve(lobby); return;
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

  const analysis=analyseRoll(g.dice);

  if(analysis.conflict){
    g.phase='CHOOSE_COMBO';
    g.comboOptions=analysis.primary;
    g.combos=[];
    g.status=`${g.players[g.cur].name} rolled! Conflicting combos — choose one to use.`;
    broadcastGame(lobby);
    // Bot auto-chooses
    if(g.isSolo&&g.cur===1) setTimeout(()=>botTurn(lobby),1500);
  } else {
    g.comboOptions=null;
    applyComboList(lobby,analysis.combos);
  }
}

function resolveChosenCombo(lobby,chosen){
  const g=lobby.game;
  g.comboOptions=null;

  // After chosen primary, check if DOUBLE coexists
  const combos=[chosen];
  if(canDoubleCoexist(g.dice,chosen)) combos.push('DOUBLE');
  applyComboList(lobby,combos);
}

function applyComboList(lobby,combos){
  const g=lobby.game;
  g.combos=combos;
  const p=g.players[g.cur],opp=g.players[1-g.cur];
  const msgs=[];

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
    if(g.isSolo&&g.cur===1) setTimeout(()=>botTurn(lobby),1000);
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
  g.status=`${g.players[g.cur].name}'s turn — play cards or roll the dice.`;
  broadcastGame(lobby);
  // If next player is bot, schedule bot turn
  if(g.isSolo&&g.cur===1) setTimeout(()=>botTurn(lobby),1600);
}

// ─── BOT AI ──────────────────────────────────────────────
function botTurn(lobby){
  const g=lobby.game;
  if(!g||g.winnerIdx!==null||g.cur!==1||!g.isSolo)return;
  if(g.phase==='CARD_PLAY'){
    // Decide cards to play
    const bot=g.players[1], opp=g.players[0];
    g.sel=[];
    // Play all Temptress cards (always beneficial)
    bot.hand.forEach((c,i)=>{ if(c==='TEMPTRESS') g.sel.push(i); });
    // Play Boy if opponent has bottles
    if(!g.sel.length){
      const boyIdx=bot.hand.indexOf('BOY');
      if(boyIdx>=0&&opp.stall.some(s=>s===2)) g.sel.push(boyIdx);
    }
    // Note: bot never plays 2 Bullies offensively (keeps them for defence)
    broadcastGame(lobby);
    setTimeout(()=>{ if(g.phase==='CARD_PLAY'&&g.cur===1) processCardPlays(lobby); },1400);
  } else if(g.phase==='CHOOSE_COMBO'){
    // Prefer TRIPLE_DOUBLE (stocks bottles) then QUAD (opens slots) then PENTA
    const order=['TRIPLE_DOUBLE','QUAD','PENTA'];
    const choice=order.find(k=>g.comboOptions.includes(k))||g.comboOptions[0];
    setTimeout(()=>resolveChosenCombo(lobby,choice),600);
  } else if(g.phase==='BLIND_PICK'){
    // Bot picks a random card from human's hand
    const opp=g.players[0];
    if(opp.hand.length>0){
      const idx=Math.floor(Math.random()*opp.hand.length);
      setTimeout(()=>{
        trash(g,opp.hand.splice(idx,1)[0]);
        g.status=`The Peddler blindly picks a card from ${g.players[0].name}'s hand!`;
        rollAndResolve(lobby);
      },1200);
    } else {
      rollAndResolve(lobby);
    }
  } else if(g.phase==='DISCARD'){
    // Smart discard: priority to keep = BULLY (defence), BOY (steal), TEMPTRESS (bonus)
    // Discard lowest priority first
    setTimeout(()=>{
      const p=g.players[1];
      if(p.hand.length<=3){endTurn(g,lobby);return;}
      const priority={'BULLY':3,'BOY':2,'TEMPTRESS':1};
      // Find lowest priority card to discard
      let discardIdx=0, lowestPri=99;
      p.hand.forEach(function(c,i){
        const pri=priority[c]||0;
        if(pri<lowestPri){lowestPri=pri;discardIdx=i;}
      });
      trash(g,p.hand.splice(discardIdx,1)[0]);
      if(p.hand.length<=3)endTurn(g,lobby);
      else{broadcastGame(lobby);botTurn(lobby);}
    },800);
  }
}

function botDefend(lobby){
  const g=lobby.game; if(!g||g.phase!=='BOY_DEFEND')return;
  const bot=g.players[1];
  const hasBully=bot.hand.includes('BULLY');
  if(hasBully){
    const bi=bot.hand.indexOf('BULLY');
    bot.hand.splice(bi,1);trash(g,'BULLY');
    g.stats[1].cards++;
    g.status=`${bot.name} plays the Bully! The theft is stopped.`;
  } else {
    doSteal(g);
  }
  rollAndResolve(lobby);
}

// ─── HTTP ────────────────────────────────────────────────
const server=http.createServer((req,res)=>{
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
      if(lobby.game) broadcastGame(lobby);
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
        if(lobby.game.cur===1) setTimeout(()=>botTurn(lobby),1800);
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
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=Crimson+Text:ital,wght@0,400;0,600;1,400;1,600&family=IM+Fell+English:ital@0;1&display=swap" rel="stylesheet">
<style>
:root{
  --wood-dark:#1c0f08;--wood:#2e1a0e;--wood-mid:#3d2210;--wood-light:#4e2e16;
  --felt:#0d2b1a;--felt-mid:#112e1c;
  --amber:#c8860a;--gold:#d4a843;--gold-light:#edc96a;
  --cream:#f2e4c0;--cream-dark:#c8b888;
  --red:#7a1818;--red-light:#9e2020;
  --green:#2a7040;--green-light:#3a9054;
  --border:#6a4818;--border-bright:#a07028;
}
*{box-sizing:border-box;margin:0;padding:0;writing-mode:horizontal-tb!important;direction:ltr!important}
body{background:var(--wood-dark);background-image:repeating-linear-gradient(90deg,rgba(255,255,255,0) 0,rgba(255,255,255,0) 3px,rgba(255,255,255,.012) 3px,rgba(255,255,255,.012) 4px),repeating-linear-gradient(0deg,rgba(0,0,0,0) 0,rgba(0,0,0,0) 10px,rgba(0,0,0,.04) 10px,rgba(0,0,0,.04) 11px);min-height:100vh;font-family:'Crimson Text',serif;color:var(--cream)}

/* ── CONN BAR ── */
#conn-bar{background:rgba(0,0,0,.5);border-bottom:1px solid rgba(160,112,40,.2);padding:.3rem 1rem;display:flex;align-items:center;gap:.45rem;font-size:.72rem;color:var(--cream-dark);font-family:'Cinzel',serif;letter-spacing:.07em}
.conn-dot{width:7px;height:7px;border-radius:50%;background:#555;flex-shrink:0}
.conn-dot.ok{background:#3aad60}.conn-dot.wait{background:var(--amber);animation:pulse 1.2s infinite}.conn-dot.err{background:var(--red-light)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

/* ── HEADER ── */
.header{text-align:center;padding:.9rem 1rem .3rem}
.header h1{font-family:'Cinzel',serif;font-size:clamp(1.6rem,4vw,2.4rem);font-weight:700;color:var(--gold);letter-spacing:.25em;text-shadow:0 0 18px rgba(212,168,67,.3),0 3px 8px rgba(0,0,0,.8)}
.header .tagline{font-family:'IM Fell English',serif;font-style:italic;color:var(--cream-dark);font-size:.85rem;margin-top:.2rem}

/* ── SCREENS ── */
.screen{display:none;padding:.5rem}
.screen.active{display:block}

/* ── LOBBY SCREEN ── */
.lobby-wrap{max-width:600px;margin:0 auto;display:flex;flex-direction:column;gap:.8rem}
.panel{background:var(--felt);border:1.5px solid var(--border);border-radius:12px;padding:1.2rem 1.4rem}
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
.game-layout{display:flex;gap:.6rem;align-items:flex-start;max-width:1100px;margin:0 auto}
.game-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:.5rem}

/* ── RULES SIDEBAR ── */
.rules-sidebar{width:230px;flex-shrink:0;background:var(--felt);border:1.5px solid var(--border);border-radius:12px;padding:.9rem 1rem;font-size:.82rem;line-height:1.5;display:flex;flex-direction:column;gap:.65rem;position:sticky;top:.5rem;max-height:calc(100vh - 80px);overflow-y:auto}
.rules-sidebar::-webkit-scrollbar{width:4px}
.rules-sidebar::-webkit-scrollbar-track{background:transparent}
.rules-sidebar::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
.rules-sidebar h3{font-family:'Cinzel',serif;font-size:.78rem;color:var(--gold-light);letter-spacing:.12em;margin-bottom:.3rem}
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
/* ── COMBO FLASH ── */
#combo-flash{position:absolute;left:50%;transform:translateX(-50%);pointer-events:none;z-index:50;text-align:center;white-space:nowrap}
@keyframes flashIn{0%{opacity:0;transform:translateX(-50%) scale(.7)}30%{opacity:1;transform:translateX(-50%) scale(1.1)}60%{opacity:1;transform:translateX(-50%) scale(1)}85%{opacity:1;transform:translateX(-50%) scale(1)}100%{opacity:0;transform:translateX(-50%) scale(1)}}
.flash-text{font-family:'Cinzel',serif;font-size:1.4rem;letter-spacing:.18em;color:#fff;text-shadow:0 0 18px #d4a843,0 0 32px rgba(212,168,67,.6),0 2px 4px rgba(0,0,0,.9);animation:flashIn 3.5s ease-out forwards}
/* ── ROLL EXPLAIN BOX ── */
.roll-explain{background:rgba(0,0,0,.2);border:1px solid rgba(160,112,40,.2);border-radius:6px;padding:.4rem .7rem;font-style:italic;font-size:.82rem;color:var(--cream-dark);text-align:center;min-height:1.5rem}

/* ── PLAYER AREAS ── */
.player-area{background:var(--felt);border:1.5px solid var(--border);border-radius:11px;padding:.8rem .9rem .7rem;transition:border-color .4s,box-shadow .4s}
.player-area.active-turn{border-color:var(--gold);box-shadow:0 0 20px rgba(212,168,67,.18)}
.player-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:.6rem}
.pname{font-family:'Cinzel',serif;font-size:.88rem;color:var(--gold-light);font-weight:600;letter-spacing:.1em;display:flex;align-items:center;gap:.35rem}
.you-tag{font-size:.62rem;background:rgba(212,168,67,.12);border:1px solid rgba(212,168,67,.28);border-radius:4px;padding:.08rem .4rem;letter-spacing:.07em}
.supply-info{font-size:.82rem;color:var(--cream-dark);font-style:italic}
.stall{display:flex;gap:.42rem;flex-wrap:wrap;margin-bottom:.6rem}
.stall-slot{width:52px;height:74px;border:2px dashed rgba(160,112,40,.32);border-radius:8px;background:rgba(0,0,0,.2);display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden;transition:all .3s}
.stall-slot.blocked{border:2px solid var(--red);background:rgba(90,20,20,.15)}
.stall-slot.filled{border:2px solid var(--green);background:rgba(30,80,45,.2);box-shadow:inset 0 0 9px rgba(40,100,60,.2)}
.slot-num{position:absolute;bottom:2px;right:4px;font-size:.54rem;font-family:'Cinzel',serif;opacity:.22;color:var(--cream)}
.red-cube{width:32px;height:32px;background:linear-gradient(145deg,var(--red-light) 0%,var(--red) 60%,#5a1010 100%);border-radius:6px;box-shadow:2px 3px 6px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.12)}
.bottle-svg{display:block;width:26px;height:52px}
.hand-header{font-family:'IM Fell English',serif;font-style:italic;font-size:.78rem;color:var(--cream-dark);margin-bottom:.4rem;opacity:.8}
.hand-cards{display:flex;gap:.4rem;flex-wrap:wrap;min-height:64px;align-items:flex-start}
.empty-hand{font-style:italic;color:rgba(200,184,136,.25);font-size:.78rem;align-self:center}

/* ── CARDS ── */
.card-wrap{position:relative}
.card{width:64px;height:90px;border-radius:7px;border:1.5px solid rgba(160,112,40,.5);display:flex;flex-direction:column;align-items:center;justify-content:center;user-select:none;overflow:visible;box-shadow:2px 3px 7px rgba(0,0,0,.5);transition:transform .18s,box-shadow .18s,border-color .18s;position:relative}
.card.face-up{background:linear-gradient(165deg,#f8edcc 0%,#ead9a8 55%,#d8c68a 100%);cursor:pointer}
.card.face-up::before{content:'';position:absolute;inset:4px;border:1px solid rgba(140,100,30,.25);border-radius:4px;pointer-events:none}
.card.face-up:hover{transform:translateY(-4px);box-shadow:3px 6px 14px rgba(0,0,0,.6)}
.card.selected{border-color:var(--amber);transform:translateY(-8px);box-shadow:0 0 14px rgba(200,134,10,.5)}
.card.face-down{background:linear-gradient(165deg,var(--wood-mid) 0%,var(--wood) 60%,var(--wood-dark) 100%);cursor:default}
.card.face-down::after{content:'✦';color:var(--gold);font-size:1.4rem;opacity:.25}
.card-icon{font-size:1.55rem;line-height:1}
.card-name{font-family:'Cinzel',serif;font-size:.5rem;font-weight:600;text-align:center;margin-top:3px;letter-spacing:.06em;color:#3a2000;padding:0 3px;line-height:1.2}
.card-divider{width:52%;height:1px;background:rgba(140,100,30,.35);margin:2px 0}
.card-desc-short{font-size:.42rem;text-align:center;padding:0 3px;color:#5a3800;font-style:italic;line-height:1.3}

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
#center{background:var(--wood);border:1.5px solid var(--border);border-radius:11px;padding:.8rem .9rem;display:flex;flex-direction:column;align-items:center;gap:.55rem}
#status-box{background:rgba(0,0,0,.2);border:1px solid rgba(160,112,40,.25);border-radius:7px;padding:.4rem .8rem;font-family:'IM Fell English',serif;font-style:italic;font-size:.95rem;color:var(--cream);text-align:center;min-height:2rem;width:100%;line-height:1.4}
#dice-row{display:flex;gap:.36rem;justify-content:center;flex-wrap:wrap}
.die{width:46px;height:46px;background:linear-gradient(145deg,#f8f0d8 0%,#ede0b8 50%,#d8c898 100%);border-radius:9px;box-shadow:3px 4px 8px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.55);display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(3,1fr);padding:5px;transition:background .3s,box-shadow .3s,transform .1s;position:relative}
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
.dot{width:7px;height:7px;background:#2a1800;border-radius:50%;margin:auto;box-shadow:0 1px 2px rgba(0,0,0,.35)}
.dot.off{visibility:hidden}
/* Combo result cards */
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
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.9);display:none;align-items:center;justify-content:center;z-index:200;backdrop-filter:blur(3px)}
.overlay.open{display:flex}
.modal{background:linear-gradient(160deg,var(--wood-light) 0%,var(--wood) 40%,var(--wood-dark) 100%);border:2px solid var(--gold);border-radius:13px;padding:1.7rem 1.9rem;max-width:420px;width:92%;text-align:center;box-shadow:0 0 50px rgba(0,0,0,.8);writing-mode:horizontal-tb!important;direction:ltr!important}
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

  /* Rules sidebar → compact accordion on mobile */
  .rules-sidebar{
    width:100%;position:static;max-height:none;
    flex-direction:column;gap:0;
    padding:.5rem .7rem;order:99
  }
  .rules-sidebar .rules-section{padding:.45rem 0;border-top:1px solid rgba(160,112,40,.2)}
  .rules-sidebar .rules-section:first-child{border-top:none}

  /* Player areas */
  .player-area{padding:.6rem .7rem .5rem}
  .pname{font-size:.82rem}
  .supply-info{font-size:.75rem}

  /* Stall — bigger slots on mobile */
  .stall{gap:.3rem}
  .stall-slot{width:48px;height:68px}
  .red-cube{width:28px;height:28px}
  .bottle-svg{width:22px;height:44px}

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
  .card{width:72px;height:100px;border-radius:8px}
  .card-icon{font-size:1.7rem}
  .card-name{font-size:.54rem;margin-top:4px}
  .card-desc-short{font-size:.44rem}
  .hand-cards{gap:.35rem;min-height:72px}
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

  /* Modal */
  .modal{padding:1.2rem 1.3rem;width:96%}
  .modal h2{font-size:1.4rem}
  .modal p{font-size:1.1rem}

  /* Win stats grid */
  .stats-grid{grid-template-columns:1fr 1fr}
}

@media(max-width:380px){
  .stall-slot{width:42px;height:60px}
  .die{width:44px;height:44px}
  .card{width:64px;height:90px}
}
</style>
</head>
<body>

<div id="conn-bar"><div class="conn-dot wait" id="conn-dot"></div><span id="conn-label">Connecting…</span></div>
<div id="reconnect-banner"><div class="reconnect-spinner"></div><span id="reconnect-msg">Reconnecting…</span></div>
<div class="header"><h1>NINE OILS</h1><p class="tagline">a game of luck and will &nbsp;·&nbsp; by David Marques</p></div>

<!-- ══ NAME SCREEN ══ -->
<div class="screen active" id="screen-name" style="max-width:520px;margin:1rem auto">
  <div class="panel">
    <h2>Welcome to the Fair</h2>
    <div class="name-form">
      <input class="name-input" id="name-input" type="text" maxlength="18" placeholder="Your vendor name…" autocomplete="off">
      <button class="btn" onclick="submitName()">Enter the Fair →</button>
    </div>
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

    <!-- Main game column -->
    <div class="game-main">

      <!-- Opponent -->
      <div class="player-area" id="opp-area">
        <div class="player-header">
          <span class="pname" id="opp-name-label">Opponent</span>
          <span class="supply-info">Supply: <span id="opp-supply">6</span></span>
        </div>
        <div class="stall" id="opp-stall"></div>
        <div class="gold-line"></div>
        <div class="hand-header">Opponent's Hand</div>
        <div class="hand-cards" id="opp-hand"></div>
      </div>

      <!-- Center / Dice -->
      <div id="center">
        <div id="status-box">—</div>
        <div class="roll-explain" id="roll-explain"></div>
        <div id="dice-row"></div>
        <div id="combo-flash" style="position:relative;height:0;overflow:visible"></div>
        <div id="combo-row"></div>
        <div class="btn-row" id="action-btns"></div>
      </div>

      <!-- Me -->
      <div class="player-area" id="my-area">
        <div class="player-header">
          <span class="pname" id="my-name-label">You <span class="you-tag">YOU</span></span>
          <span class="supply-info">Supply: <span id="my-supply">6</span></span>
        </div>
        <div class="stall" id="my-stall"></div>
        <div class="gold-line"></div>
        <div class="hand-header">Your Hand</div>
        <div class="hand-cards" id="my-hand"></div>
      </div>

    </div><!-- /game-main -->

    <!-- Rules Sidebar -->
    <div class="rules-sidebar">
      <div class="rules-section">
        <h3>🎯 Objective</h3>
        <div style="font-size:.74rem;color:var(--cream-dark);line-height:1.45">
          Fill all <strong style="color:var(--cream)">6 slots</strong> in your stall with green bottles. First to do it wins!
        </div>
      </div>

      <div class="rules-section">
        <h3>🎲 Dice Combos</h3>
        <div class="combo-entry">
          <div class="combo-name">DOUBLE</div>
          <div class="combo-dice">Any 2 matching dice</div>
          <div class="combo-effect">→ Draw 1 Character card</div>
        </div>
        <div class="combo-entry">
          <div class="combo-name">TRIPLE + DOUBLE</div>
          <div class="combo-dice">3 of one + 2 of another</div>
          <div class="combo-effect">→ Stock 1 bottle in your stall</div>
        </div>
        <div class="combo-entry">
          <div class="combo-name">QUAD</div>
          <div class="combo-dice">4 of the same value</div>
          <div class="combo-effect">→ Remove 1 red blocking cube</div>
        </div>
        <div class="combo-entry">
          <div class="combo-name">PENTA</div>
          <div class="combo-dice">5 of the same value</div>
          <div class="combo-effect">→ Opponent discards entire hand</div>
        </div>
      </div>

      <div class="rules-section">
        <h3>🃏 Your Turn</h3>
        <div style="font-size:.74rem;color:var(--cream-dark);line-height:1.5">
          1. Play any cards (optional)<br>
          2. Roll all 9 dice<br>
          3. Resolve all combos<br>
          4. Discard to 3 cards max
        </div>
      </div>

      <div class="rules-section">
        <h3>👤 Characters</h3>
        <div class="card-rule">
          <div class="card-rule-name">💃 The Temptress</div>
          <div class="card-rule-text">Play before rolling. Adds +1 bottle on a Triple+Double. Two Temptresses = +2 bottles.</div>
        </div>
        <div class="card-rule">
          <div class="card-rule-name">🤏 The Boy</div>
          <div class="card-rule-text">Steal 1 bottle from opponent's stall. Can be blocked by a Bully.</div>
        </div>
        <div class="card-rule">
          <div class="card-rule-name">👊 The Bully (I)</div>
          <div class="card-rule-text">Play on opponent's turn to cancel a Boy attack.</div>
        </div>
        <div class="card-rule">
          <div class="card-rule-name">👊 The Bully (II)</div>
          <div class="card-rule-text">Play 2 Bullies on your turn — blindly discard 1 card from opponent's hand.</div>
        </div>
      </div>

      <div class="rules-section">
        <h3>⚔️ Conflicts</h3>
        <div style="font-size:.74rem;color:var(--cream-dark);line-height:1.45">
          When the same dice qualify for multiple combos, you choose which one to use.
        </div>
      </div>
    </div><!-- /rules-sidebar -->

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
    <h2>The Boy Strikes!</h2>
    <p id="boy-msg">Opponent plays The Boy!</p>
    <div class="gold-line"></div>
    <div class="hand-cards" id="boy-hand" style="justify-content:center;margin-bottom:.7rem"></div>
    <div class="modal-btns">
      <button class="btn" id="defend-btn" onclick="send({type:'BOY_DEFEND',defend:true})">Play Bully to Defend</button>
      <button class="btn danger" onclick="send({type:'BOY_DEFEND',defend:false})">Take the Hit</button>
    </div>
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
  <div class="modal" id="win-modal" style="max-width:480px">
    <div class="modal-icon">🍾</div>
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
  PENTA:        { label:'🎯 Penta',          desc:'Opponent discards their entire hand', detail:'5 dice showing the same value' },
  QUAD:         { label:'🔓 Quad',           desc:'Remove 1 red blocking cube from your stall', detail:'4 dice showing the same value' },
  TRIPLE_DOUBLE:{ label:'🍾 Triple + Double',desc:'Stock 1 bottle (+ Temptress bonus if active)', detail:'3 of one value + 2 of another value' },
  DOUBLE:       { label:'🎲 Double',         desc:'Draw 1 Character card from the deck', detail:'Any 2 dice showing the same value' },
};

const DOTS={1:[4],2:[2,6],3:[2,4,6],4:[0,2,6,8],5:[0,2,4,6,8],6:[0,2,3,5,6,8]};

// ══ STATE ══════════════════════════════════════════════════
let ws=null, myName='', myIdx=-1, state=null, lastDice=null;
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
      hideReconnectBanner(true);
      setConn('ok','Reconnected');
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
let lastFlashedCombos = '';

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
  renderOppHand(s.oppHandCount);
  $('status-box').textContent=s.status;
  $('roll-explain').textContent=s.rollExplain?'You rolled: '+s.rollExplain:'';
  renderDice(s.dice,s.combos||[]);
  renderComboBadges(s.combos||[],s.status);

  // Only trigger flash when we get NEW combos — never clear it mid-animation
  const comboKey = (s.combos||[]).join(',');
  if(comboKey && comboKey !== lastFlashedCombos){
    lastFlashedCombos = comboKey;
    showComboFlash(s.combos);
  }

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
        // New bottle — animate in
        slot.querySelector('svg').classList.add('bottle-anim');
        // Glow the slot border too
        slot.style.boxShadow='0 0 18px rgba(58,173,96,.8)';
        setTimeout(()=>{ if(slot.parentNode) slot.style.boxShadow=''; }, 900);
      } else if(change && change.type==='stolen'){
        slot.querySelector('svg').classList.add('stolen-anim');
      }
    } else if(change && change.type==='cube_removed'){
      // Slot just became empty — show a cube briefly then animate out
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

const CARD_IMGS={
  TEMPTRESS:"data:image/png;base64,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ECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGZElzn4zovbyxwegDFLC9aDNwrLGhqAUSwJAZhBsACYQbAAmEGwAJhBsACYQbAAmEGwAJhBsACYQbAAmEGwAJhBsACYQbAAmEGwAJhBsACYsdT3w8Ji3bz5tBqNuqRQjuOoUNhXo1HXjRtP6aOP3ht7TCaT1cbGFd269YE6nU5/Wyazrm63qzDs6vDwvtrt9sgYPbVaReVycewYg9vS6TWtreUUhr25lctFVSrlR/ab9nqOj4/6x0yax+B213VVKDxQvR6c47uJi4hgrZAwDHXv3seSJM+La3Pzqu7e/WjqMb6fUrlcku+nVKmU5ftJpVIZ3b37kcIwlO+ntLW1rXv3bj0yxrx8P6VMJqt79z5Wt9uV67q6evW6Op22gqA21+txHFdXr15TGIaqVo8nzmP0e7C1ta07dz4803xxcbEkXFHNZkOxWGzqPo7jyHVdVSpHSibTkqS1tQ0ViwcKw1CSFARVtVotOY5z7rlkszkVCvvqdruSpG63q0LhQGtrG3OfIwxPj1mf+5hms6FolL+TVwn/NVdUIpFUs9mYuo/vp06C1FQ0GpPjOPI875HjDg/vf6K5xGKPnrPZrMvzvDOdp9VqKBqd/5je65t8BQd7CNYKcRxH29tPSOpdxRwcTA9NMpmW58WVTGYUiUSUSPhnGkOSisXefbLR7af7Ltrpld+seThOL5S3b7McXCUEa4Wc9f5SLOb17+/4fkq+n1ar1ZLnxYduaG9tbevg4N7UMcZtv3HjKUlSs9mU5yXUaDy8+e15CTWbzflfnKR4PKFWqzH3PLLZDaXTazo64vkBq4J7WJdUIuEPLdPq9Zp8P6nj45LW17f6V0epVOYTXymVywVtbGzJdXt/3FzX1cbG1plC4roR5XJ5HR0V5z4mCKqKxxNnni8uLq6wLgHHcfSZzzxcPtXrgRzHUb3+8P5OGIbqdDpqNhtqNGq6du2mOp22Op2OCoUHQ+caXIo1GoGKxYOp4wdBTZFITNvbTwz9WsPp+OPmVyweDIzVO+boqDB0zKx5tFpNeV78DN8pXHTOzs5uOLhh98s7/Y/3XrnV/zi9m1Blry4AWKTRtkxqkMSSEIAhBAuAGQQLgBkEC4AZBAuAGQQLgBkEC4AZBAuAGQQLgBkEC4AZBAuAGQQLgBkEC4AZBAuAGQQLgBkEC4AZBOuCyuevK5fLK5fLa2PjqmKx871zZj5/bcEzmy4ajcn30/3Pk8nMwucyeM5F+LS/Rzg/gnVhhSoW91Us7qtcLiiTWV/2hObSbrcUBJX+56nUYuPyuM4JG3hPdwPa7ZZcNyLHcZXJrJ98LFUqR2q1ek+eyeevKQiqisV6z+0rl4vqdNr9c0SjMWUyuZP3cq+qVqvIdV1lMjm5rqswDFUuFxSGmjiGJG1ubqtU2len09H6+pY6nbaOj0vyvLgSiZTK5YLy+Wva37+jVGpNjuNqfX1LpVLv/dZTqaw8z5PjuKpWy0NP0hk3x9PX1mgEarVacl23f85IJDp1LpXKkdbWeufrvb6iut3O0PkG4+q6rtbX8yqXC2q3W4/vPyjOjSssAzyv93irdDqrIKioVDq96soN7OWo3W6pWNxXEFSVTmeHzuH7aVUqRyqV9vtLqnR6/eThDfuq1wOlUtkZY/QegPpweeooGu09XToWi6vZHH7P/2q1rDDs9mMlOQrDjorFfR0dHSqdXp85x9Pj6vVAQVAZOuesuaTTWdXrtZPXVxv4njw8X38Ex9Ha2qYqlRKxusC4wrqwHOVyeUmOIpGoCoX72ti4MvTo9dHHb51erTQawSPBqlRKSiSSiscTcpze31OeF9fxce+xWfV6VY1GoM3NqzPGqCse99Vut9RuP3xidCwWVxBUZ76q0ycxdzptue7wucfN8dRoDOeZSzqd7b++0e/J6Pl68a7NfFo2lotgXVi9e1hS7yZzIpGUJJVKB/2nH4/eiD/d3vt4+GzZ7KYajUC1WmXopvjw8d2ZY5xe6bXbnlqtpsIwlOfF5ThSt9uZ/apOxhhn8hzDsfuffy6j53t4dSbNji6WhyWhAb2lT+9/yni89zh5z0s8cvP59KGh8bjff0LyqWjU6z+P8FTvuX29Y3w/pXQ6O3OMMAzV7Xb6Y7RaTfl+ZsqVyeBV1PjwTJvjtHPOmkuz2ei/lnjcnzLHUMXiA0UiUfl+asbYWCaCZUCn01Y0GusvmXK5vJLJjI6PSwN7hYrHe1+Lx5OqVEr9Y5PJjIKgolwur1Rqrf8w00rlSMlkWrlcXp7nq1o9njFGT7NZl+tG1O121Wo15HnxiTFotRpaX9+a63WOm+Osc06bS6Vy1H8tiURSlcrR1PHL5UMlk5n+Dy5w8fAg1RVx+pM5wBoepApgJRGsFcHVFS4DggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXAjKW9RfLge94AsGf0vao+DUsL1jJeLADbWBICMINgATCDYAEwg2ABMINgATCDYAEwg2ABMINgATCDYAEwg2ABMINgATCDYAEwg2ABMINgATCDYAEwg2ABMINgATCDYAEwg2ABMGNp7+mOT08y52vtSlqSlEjHVa80JEnHDyra+uyGGtVmf99aqa7y/WPd/MJ11Y7q2n//sP+1/Gc3lMz5+vA/b0uSbn7hev9Yx3FU+LikiBeZayw34qrwcUn148bQeQbn4CVjyu1k5TiOwlA63Cuo3exM3I7VR7AugVoxUK0YSJJuvHBN93683//a5m449PmpMAwVS0QlR1LY2xZNRBWG4dA+p8d6fkybuznd/dGDucby/Ji2PrehO2/fHzrPoK3dDT1470DtZkfJnK/czrr2PzicuB2rj2Bhoma1qXjSU6PalJeMqVlr9SI2bt+gpVh8/j9OzaClaCwydZ9IzJXjOJKkoFRXt9Wduh2rj3tYmCgoN+RnE5Ikfy2hoFyfuG9iLa5mrTX3uf21hILjxtR9irfL2n4mr63dnOJpr7+8nLQdq48rrEvOcRxtfz7f/7x4+0iNSu9+UlCuK3NlU7rTC9Lx+9WJx3Y7oQ4+LM41luM4iiWiuv32/alzqBxUVSsGSuZ8bdxYV60YqHSnPHE7Vh/BuuQm3T+SpG67K4VS1Ost3bqd4aXXtGNnjZXdzii9mdTRveOx54lEXUUT0X64glKga89f1fGDytjtBOtyYEmIqYJyXevXs6qXF7vsCsp1xVPe1H2ufG6zH0s36vZ/EjhpO1YfV1iX3OhyrFFtqnjrqP95UKor93xWd06Wb4vSqrflJWNT53DwYVH5JzcVdkMplA73iuq0u2O343JwdnZ2w8ENu1/e6X+898qt/sfp3YQqe5NvugLAeYy2ZVKDJJaEAAwhWADMIFgAzCBYAMwgWADMIFgAzDj372FN+9EjAIzzSbtx5mANDji6jXABGGdaNw7ePZj7PCwJAZhxpmCNq+RZvg7g8pnVha1ntuY+F1dYAMwgWADMOFOwZt1U56Y7gFGzusBNdwAr6Uy/1pDeTfRrOHij7HRbejexwKkBWBXTunEWcwdr9L2wKnss/wCczSftBktCAGYQLABmTF0S8ougAC4SrrAAmEGwAJjxyFNzAOCi4goLgBkEC4AZBAuAGf8Pk0LvULs0afwAAAAASUVORK5CYII=",
  BOY:"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAASwAAAGkCAYAAACLnhjAAAASuUlEQVR4nO3dfYwj913H8c+M7fHzPvtuc9ncbdtcm6RQVFoQjRoEKNC0EAEqEB4kFCoEKqoqCpUIIAr/UJp/WpAqpbSIpoWqPbWEQFAbaIpUGiUlJE0qSHJp0ss97O1tbndtr9fPY3v4w7feXd+evb7bO+/X9379tWt7Zn6zl7zv95vzepy5uflAAGCAO+wBAMBuESwAZhAsAGaEux+Yv2tuGOMAgIucfHRh2/fMsACYQbAAmHHRknCr7ukYAFxtvS5LMcMCYAbBAmBGzyXhVqn52NUcB4DrWPFkdVev23Wwune6dZ3JtS4Au7FTNwaZDA0UrO4Ddj9GuADspFc3Vo6v7Ho/XMMCYMZAwer3LnjeJQ+gW78uzNwys+t9McMCYAbBAmDGQMHqd1Gdi+4AuvXrAhfdAYykgd/WsFFL3ocFYLd6deOqvg+r+2DdXDd0ubsEMIJarWbn6yud3LAkBGAGwQJgBsECYAbBAmAGwQJgBsECYAbBAmAGwQJgBsECYAbBAmDGZf9qDkbHO9/xNr33539akvSDt71R//vC9yRJDz/yDX34g+/T3fe8f9vrHzn2QOexrz30aR3/3onOc098+zl9+eFHO99vPO/IUSIR12f/8SE9+dRzuuvOO/SLd98p328oEgnroX/9uv79G4/ryOFD+sgf/Z5++wN/piAIJEmf+uu/0P2f+Du9eorfWb3eESzo8Sef0eNPPiOpHaMP3fexznMf/uD7em7b8JvbXt/r+Te87ib95Ud+X41GU+/5mR/XH/7J/SqWykolE/ron39IK6s5PfPc83r11Fn95B0/qv/8r//Wj/3ID2nx3HliBUksCXENnTi5oGazpXve+2596u+PqVgqS5KKpbL+9rPH9Ku/9B5J0j988V/0G/fcLcdx9Ou//HP63BcfHuKosZ8QLFwzb33Lrfrkp7+gIzcd0isnTm177uXvn9L84RslSafOLOrEqwv6gw/cq/PLqzp1enEYw8U+xJIQPYUjIX3iY/dd9Nilnv/Mg1/RC8dfuej5SDiiW974Oj373Rd3PI4jp3PNSpI+/6WH9eADf6V73//He3UqGAEECz3tdI3qkWMP9Hz+Utu/fn5Of3P/n+r4yyd09A1H9PyLm2E7evMRnTx9tvP9mYUllctVnVlY2qtTwQhgSYhrZq1Q1OLSeR37p6/pd3/rHiWTcUlSKpnQ79z7K/rSV7465BFiv2OGhSvSvSR84cXv6zOf+/JFzwet9nLv4598UC+9/KoyM5P6+Efv67yt4Z8f+bq+890Xrvn4YYszNzcfbH3gUp/VnpqPqXiy2neHfEQygK22fkTyTrrb0ut+ESwJAZhBsACYQbAAmEGwAJhBsACYQbAAmEGwAJhBsACYQbAAmEGwAJhBsACYsee//Nzv94YA4HIxwwJgBsECYAbBAmAGwQJgBsECYAbBAmAGwQJgBsECYMbQ7ppz4O1Twzo0gD1w/unsNT/mUG/ztfAEN8kELJq7fXYox2VJCMAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcCM8LAHgNHxxGPH9K0nnlaz2VQoFNIdt79dt995z7CHhRFCsLBnXjj+ip586lk9/G+P6e53/5SmJseHPSSMGJaE2DPnl1fl+w29+dajWl7JanklO+whYcQQLOypRx/7ln7z135B3/6f54Y9FIwggoU99bPv+gl99T++qXe+423DHgpGEMHCnjmQmVY06umbjz+lA5lpZWamhj0kjBguumPP3HbLzVrN5vXWt9yqUCikN996dNhDwoghWNgzvIUBVxtLQgBmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmECwAZhAsAGYQLABmhId58LnbZ4d5eADGDC1Y55/ODuvQAIxiSQjADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwAyCBcAMggXADIIFwIyhfh4W9taRI0dVq1UlBXIcR9nssmq1qg4fvlmnT7+y4zbp9Limpg5oYeGEms1m57F0ekKtVktB0NLq6mtqNBpdx2grl4sqFHI7HmPrY6nUmMbGJhUE7bEVCjkVi4WLXtfrfNbX1zrbXGocWx93XVfZ7HlVq5XL+GliPyJYIyQIAi0tnZEkeV5U09MHde7c6Z7bxONJFQp5xeNJFYsFxeMJJZNpnTt3WkEQKB5PamZmVktLCxcdY7fi8aTS6XEtLZ1Rq9WS67o6ePBGNZsNVSrlXZ2P47g6ePCQgiBQqbR+yXF0/wxmZma1uHhqoPFi/2JJOKLq9ZoikUjP1ziOI9d1VSyuKZFISZLGxqaUy60oCAJJUqVSku/7chznsscyPj6pbHZZrVZLktRqtZTNrmhsbGrX+wiCjW0mdr1NvV5TOMzfyaOEP80RFYslVK/Xer4mHk9eCFJd4XBE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",
  BULLY:"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAASwAAAGkCAYAAACLnhjAAAARw0lEQVR4nO3d3Y9bZ0LH8d+xx+/2vDuZJrPN0KZp0lZAYW+oWEAIia4QLHcIIXFRuEAI/gEkJP4H7rnnDhCsqt1K7GpRQUvFIoF2u6vVkuZ1kpnYHo89fvfhwrEz9szYnsSp5+d8PzedOfZ5zuNp+815zjg+wfb2TigAMBCZ9wQAYFoEC4ANggXAxtLohp0Pt+cxDwA44fbH94a+5wwLgA2CBcDGiSXhcaOnYwDwso27LMUZFgAbBAuAjbFLwuOyO8mXOQ8Ar7DK7fpUz5s6WKODHl9ncq0LwDRO68Z5TobOFazRA45uI1wATjOuG/uf7089DtewANg4V7AmvQued8kDGDWpC5s3N6ceizMsADYIFgAb5wrWpIvqXHQHMGpSF7joDmAhnfttDf1a8j4sANMa142X+j6s0YONikSizzskgAXU7XYGX7/oyQ1LQgA2CBYAGwQLgA2CBcAGwQJgg2ABsEGwANggWABsECwANggWABsE6xWyemtZNz56Qzc+ekPv/817g69X313RL/zVOyeef3zbL/71u4Pn3/joDV36YPhD144/fuvP39LK28snxhj9/rRjnrU9mU/o1l+8JQXPtt38s+tKXeLmKK+S5/67hPBT+lFZpR+VJfWi8JO/+9ngsWvfuDp237ATDj1/3OOpraTe/KMdHfy4PINZ99T3Gqo/qmvtvVUV/6eklRs5NQpN1R5Pd7cVLAbOsDBztUd1hd1w5uM+/M5jbf16Xgqky792SQ//9dHMj4GLjWBh5nI/l9W9bz6c+bj1vYZqu3W9/ntX1Tpoqr7XmPkxcLGxJIQkKYgGuvHRGye2nfX4/W/vqnr36MTjQTRQ+mpKh/9XnemSsG/3O4/1zl/e0A//9iczHxsXH8GCpNOvUR2/+H2ua1iXk7rxJ0/jFkpBJFDYDZ/+88XmWd9vqNPoqL7P2dWriCUhZq591FGj2JQkVe/XlHszK0lavp7V0f2jcbsCY3GGhamMLgkrd4/04Nu7Jx4Pn15rv/NP9yVJd//lga5946q2vpaXJH3xj/eH9/nTNwffV+9Udf9bu2duB4Lt7Z2hX+ec9Vnt2Z2kKrcn/wqZj0gGcNzxj0g+zWhbxt0vgiUhABsEC4ANggXABsECYINgAbBBsADYIFgAbBAsADYIFgAbBAuADYIFwMbM//LzpL83BADPizMsADYIFgAbBAuADYIFwAbBAmCDYAGwQbAA2CBYAGzM7a45l766Pq9DA5iBx58VvvRjzvU2X/c+5dZNgKPtD7bmclyWhABsECwANggWABsEC4ANggXABsECYINgAbBBsADYIFgAbBAsADYIFgAbBAuADYIFwAbBAmCDYAGwQbAA2CBYAGwQLAA2CBYAGwQLgA2CBcAGwQJgg2ABsEGwANggWABsECwANggWABsEC4ANggXABsECYINgAbBBsADYIFgAbBAsADYIFgAbBAuADYIFwAbBAmCDYAGwQbAA2CBYAGwQLAA2CBYAGwQLgA2CBcAGwQJgg2ABsEGwANggWABsECwANggWABsEC4ANggXABsECYINgAbBBsADYIFgAbBAsADYIFgAbBAuADYIFwAbBAmCDYAGwQbAA2CBYAGwQLAA2CBYAGwQLgA2CBcAGwQJgg2ABsEGwANggWABsECwANggWABsEC4ANggXABsECYINgAbBBsADYIFgAbBAsADYIFgAbBAuADYIFwAbBAmCDYAGwQbAA2CBYAGwQLAA2CBYAGwQLgA2CBcAGwQJgg2ABsEGwANggWABsECwANggWABsEC4ANggXABsECYINgAbBBsADYIFgAbBAsADYIFgAbBAuADYIFwAbBAmCDYAGwQbAA2CBYAGwQLAA2CBYAG0vzngAWx6ef/L2+9+ln6nQ6ikaj+toHX9UHv/UH854WFgjBwsz88POf6t+//wP9wz9/ot/9+m9qfW1l3lPCgmFJiJl5vPdErVZb7956S3v7Be3tF+Y9JSwYgoWZ+viT7+mP//D39R//+d/zngoWEMHCTP3Ob/+Gvvmt7+pXf+WX5z0VLCCChZm5lN9QIhHXd//t+7qU31B+c33eU8KC4aI7Zuadm9f1pFDS+z9/S9FoVO/eemveU8KCIViYGd7CgJeNJSEAGwQLgA2CBcAGwQJgg2ABsEGwANggWABsECwANggWABsEC4ANggXABsECYINgAbBBsADYIFgAbBAsADYIFgAbBAuADYIFwAbBAmCDYAGwQbAA2CBYAGwQLAA2CBYAGwQLgA2CBcAGwQJgg2ABsEGwANggWABsECwANggWABsEC4ANggXABsECYINgAbBBsADYIFgAbBAsADYIFgAbBAuADYIFwAbBAmCDYAGwQbAA2CBYAGwQLAA2CBYAGwQLgA2CBcAGwQJgg2ABsEGwANggWABsECwANggWABsEC4ANggXABsECYINgAbBBsADYIFgAbBAsADYIFgAbBAuADYIFwAbBAmCDYAGwQbAA2CBYAGwQLAA2CBYAGwQLgA2CBcAGwQJgg2ABsEGwANggWABsECwANggWABsEC4ANggXABsECYINgAbBBsADYIFgAbBAsADYIFgAbBAuADYIFwAbBAmCDYAGwQbAA2CBYAGwQLAA2CBYAGwQLgA2CBcAGwQJgg2ABsEGwANggWABsECwANggWABsEC4ANggXABsECYINgAbBBsADYIFgAbBAsADYIFgAbBAuADYIFwMbSPA++/cHWPA8PwMzcgvX4s8K8Dg3AFEtCADYIFgAbBAuADYIFwAbBAmCDYAGwQbAA2CBYAGwQLAA2CBYAGwQLgA2CBcAGwQJgg2ABsDHXz8PCbF279pYajbqkUEEQqFDYU6NR1+uvX9edOz89dZ9cbkXr65d0797P1Ol0BttyuVV1u12FYVdPnjxSu90eOUbP0VFF5XLx1GMc35bNLmt5eU1h2JtbuVxUpVI+8bxxr+fw8GCwz1nzOL49EomoUHiser32HD9NXEQEa4GEYajd3buSpHg8oY2Ny3r48M7YfVKpjMrlklKpjCqVslKptDKZnB4+vKMwDJVKZbS5uaXd3XsnjjGtVCqjXG5Fu7t31e12FYlEdPnyVXU6bdVqR1O9niCI6PLlKwrDUNXq4ZnzGP0ZbG5u6cGDL841X1xcLAkXVLPZUCwWG/ucIAgUiURUqRwonc5KkpaX11Us7isMQ0lSrVZVq9VSEATPPZeVlTUVCnvqdruSpG63q0JhX8vL61OPEYb9fVan3qfZbGhpiT+TFwn/NhdUMplWs9kY+5xUKvM0SE0tLcUUBIHi8fiJ/Z48efRCc4nFTo7ZbNYVj8fPNU6r1dDS0vT79F7f2Wdw8EOwFkgQBNra+oqk3lnM/v740KTTWcXjCaXTOUWjUSWTqXMdQ5KKxd51stHt/efOWv/Mb9I8gqAXyvv3WQ4uEoK1QM57fSkWiw+u76RSGaVSWbVaLcXjiaEL2pubW9rf3x17jNO2v/76dUlSs9lUPJ5Uo/Hs4nc8nlSz2Zz+xUlKJJJqtRpTz2NlZV3Z7LIODrh/wKLgGtYrKplMDS3T6vUjpVJpHR6WtLq6OTg7ymRyL3ymVC4XtL6+qUik959bJBLR+vrmuUISiUS1tpbXwUFx6n1qtaoSieS554uLizOsV0AQBHrttWfLp3q9piAIVK8/u74ThqE6nY6azYYajSNduXJNnU5bnU5HhcLjobGOL8UajZqKxf2xx6/VjhSNxrS19ZWhtzX0j3/a/IrF/WPH6u1zcFAY2mfSPFqtpuLxxDl+Urjogu3tnfD4hp0Ptwdf3/743uDr7E5Sldt1AcAsjbblrAZJLAkBGCFYAGwQLAA2CBYAGwQLgA2CBcAGwQJgg2ABsEGwANggWABsECwANggWABsEC4ANggXABsECYINgAbBBsC6ofP6q1tbyWlvLa339smKx5/vkzHz+yoxnNt7SUkypVHbwfTqdm/lcjo85C1/2zwjPj2BdWKGKxT0Vi3sqlwvK5VbnPaGptNst1WqVwfeZzGzj8rLGhAc+091Au91SJBJVEESUy60+/VqqVA7UavXuPJPPX1GtVlUs1rtvX7lcVKfTHoyxtBRTLrf29LPcqzo6qigSiSiXW1MkElEYhiqXCwpDnXkMSdrY2FKptKdOp6PV1U11Om0dHpYUjyeUTGZULheUz1/R3t4DZTLLCoKIVlc3VSr1Pm89k1lRPB5XEERUrZaH7qRz2hz7r63RqKnVaikSiQzGjEaXxs6lUjnQ8nJvvN7rK6rb7QyNdzyukUhEq6t5lcsFtdutl/cvFM+NMywD8Xjv9lbZ7IpqtYpKpf5Z19qxZwVqt1sqFvdUq1WVza4MjZFKZVWpHKhU2hssqbLZ1ac3b9hTvV5TJrMy4Ri9G6A+W54GWlrq3V06Fkuo2Rz+zP9qtaww7A5iJQUKw46KxT0dHDxRNrs6cY79/er1mmq1ytCYk+aSza6oXj96+vqOjv1Mno03OEIQaHl5Q5VKiVhdYJxhXViB1tbykgJFo0sqFB5pff3S0K3XR2+/1T9baTRqJ4JVqZSUTKaVSCQVBL0/p+LxhA4Pe7fNqterajRq2ti4POEYdSUSKbXbLbXbz+4YHYslVKtVJ76q/p2YO522IpHhsU+bY99oDKeZSza7Mnh9oz+T0fF68T6aeLdszBfBurB617Ck3kXmZDItSSqV9gd3Px69EN/f3vt6eLSVlQ01GjUdHVWGLooP79+deIz+mV67HVer1VQYhorHEwoCqdvtTH5VT49xmrPnGJ76/Oefy+h4z87OpMnRxfywJDTQW/r0/qdMJHq3k4/HkycuPvdvGppIpAZ3SO5bWooP7kfY17tvX2+fVCqjbHZl4jHCMFS32xkco9VqKpXKjTkzOX4WdXp4xs1x3JiT5tJsNgavJZFIjZljqGLxsaLRJaVSmQnHxjwRLAOdTltLS7HBkmltLa90OqfDw9KxZ4VKJHqPJRJpVSqlwb7pdE61WkVra3llMsuDm5lWKgdKp7NaW8srHk+pWj2ccIyeZrOuSCSqbrerVquheDxxZgxarYZWVzenep2nzXHSmOPmUqkcDF5LMplWpXIw9vjl8hOl07nBLy5w8XAj1QXR/80c4IYbqQJYSARrQXB2hVcBwQJgg2ABsEGwANggWABsECwANggWABsEC4ANggXABsECYINgAbBBsADYIFgAbBAsADbm9hHJxz/zBoCf0c+q+jLMLVjzeLEAvLEkBGCDYAGwQbAA2CBYAGwQLAA2CBYAGwQLgA2CBcAGwQJgg2ABsEGwANggWABsECwANggWABsEC4ANggXABsECYINgAbBBsADYIFg407Vfuqqtt/PaejuvK+9cVno1KUl6/f0rQ887/v3oY+O2x1IxXXn38tC2K+9cUjwVe9GpY0HN7SYUuPjCMNTuj/ckSfF0TJeub+qo9HBm47dqLbVqLWXW06oWjpRaSapV76hZa83sGFgsnGFhKs2jlhSGMx+39OBQK6/lJEmrry2r9LA882NgcRAsTCW5nFDhbmnm47bqvbOsjZ01tZtttTi7whgsCXGmIAi09XZeQSRQIh1X7bCuo1J95scpPSjr6ntbuv+/uzMfG4uFYOFMQ9ewUjFt3cw/ezCQFErB03++iFa9rW6nq1a9/WIDYeGxJMRUOu2u2o2OJKlRbSq13PuNYXI5qUa1Oc+p4RXCGRbO1F8S9j35oihJKtwpaePamla2ckPb+/u8dvPS4Pt6paHivYMztwPnQbBwpi/+6/6p21v19mCpOO0+Z23vu/ODB+ebHF5JLAkB2CBYAGwQLAA2CBYAGwQLgA2CBcDGc7+tYefD7cHXtz++N5PJAFhsL9qNcwfr+AFHtxEuAKcZ1439z/enHoclIQAb5wrWaZU8z+MAXj2TurB5c3PqsTjDAmCDYAGwca5gTbqozkV3AKMmdYGL7gAW0rne1pDdSQ5qePxCWX9bdic5w6kBWBTjunEeUwercrs+8j3LPwDn86LdYEkIwAbBAmBj7JKQN4ICuEg4wwJgg2ABsBFsb++84G0wAeDLwRkWABsEC4ANggXAxv8D0Xin/tVXaEgAAAAASUVORK5CYII=",
};

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
  const imgTag = CARD_IMGS[type]
    ? '<img src="'+CARD_IMGS[type]+'" style="width:120px;height:auto;border-radius:7px;border:1.5px solid rgba(160,112,40,.5);display:block">'
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
  const numStyle='text-align:right;padding:.3rem .6rem;font-family:Cinzel,serif;font-size:1.2rem;color:var(--gold);font-weight:700';
  const numStyleOpp='text-align:left;padding:.3rem .6rem;font-family:Cinzel,serif;font-size:1.2rem;color:var(--cream-dark);font-weight:700';
  const txtStyle='text-align:right;padding:.3rem .6rem;font-family:Cinzel,serif;font-size:.82rem;color:var(--gold);font-weight:700';
  const txtStyleOpp='text-align:left;padding:.3rem .6rem;font-family:Cinzel,serif;font-size:.82rem;color:var(--cream-dark);font-weight:700';
  const midStyle='text-align:center;padding:.3rem .4rem;font-size:.82rem;color:var(--cream-dark);font-style:italic;white-space:nowrap';
  let rowsHtml='';
  rows.forEach(function(r){
    const ms=r.text?txtStyle:numStyle;
    const os=r.text?txtStyleOpp:numStyleOpp;
    rowsHtml+='<tr><td style="'+ms+'">'+r.me+'</td><td style="'+midStyle+'">'+r.label+'</td><td style="'+os+'">'+r.opp+'</td></tr>';
  });
  const hdrStyle='font-family:Cinzel,serif;font-size:.75rem;opacity:.7;padding:.2rem .6rem';
  el.innerHTML=
    '<div style="font-family:Cinzel,serif;font-size:.82rem;color:var(--gold-light);letter-spacing:.1em;text-align:center;margin-bottom:.5rem">— Game Summary —</div>'+
    '<table style="width:100%;border-collapse:collapse">'+
      '<thead><tr>'+
        '<th style="text-align:right;color:var(--gold-light);'+hdrStyle+'">'+s.myName+'</th>'+
        '<th></th>'+
        '<th style="text-align:left;color:var(--cream-dark);'+hdrStyle+'">'+s.oppName+'</th>'+
      '</tr></thead>'+
      '<tbody>'+rowsHtml+'</tbody>'+
    '</table>';
}

function renderButtons(s){
  const el=$('action-btns'); el.innerHTML='';
  if(!s.isMyTurn){
    if(s.phase==='CARD_PLAY'||s.phase==='CHOOSE_COMBO')
      el.innerHTML='<span style="font-style:italic;color:var(--cream-dark);font-size:.88rem">Waiting for '+s.oppName+'…</span>';
    return;
  }
  if(s.phase==='CARD_PLAY'){
    const b=document.createElement('button');
    b.className='btn';b.textContent=s.sel.length?'✔ Confirm Cards & Roll':'🎲 Roll Dice';
    b.onclick=()=>send({type:'ROLL'});el.appendChild(b);
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
    $('combo-overlay-msg').textContent=explain+'These combos conflict — pick one:';
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

  // BOY DEFEND
  if(s.phase==='BOY_DEFEND'&&!s.isMyTurn){
    $('boy-msg').textContent=s.oppName+' plays The Boy! Defend with a Bully?';
    $('defend-btn').disabled=!s.myHand.includes('BULLY');
    const hd=$('boy-hand');hd.innerHTML='';
    s.myHand.forEach(c=>{const wrap=document.createElement('div');wrap.className='card-wrap';const el=makeCard(c,true);el.onclick=()=>openCardInfo(c);wrap.appendChild(el);wrap.appendChild(makeTooltip(c));hd.appendChild(wrap);});
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
    // Remove all group classes
    for(let g=0;g<6;g++) die.classList.remove('grp-'+g);
    if(changed){die.classList.add('rolling');setTimeout(()=>die.classList.remove('rolling'),520);}
    const on=DOTS[val]||[];
    die.querySelectorAll('.dot').forEach((d,c)=>d.className='dot'+(on.includes(c)?'':' off'));
    if(groupMap[val]!==undefined) die.classList.add('grp-'+groupMap[val]);
  });
}

function renderComboBadges(combos, statusText){
  const el=$('combo-row');el.innerHTML='';
  if(!combos||!combos.length) return;

  // Parse how many bottles were stocked from the status text
  const bottleMatch = statusText && statusText.match(/(\d+) bottle/);
  const bottleCount = bottleMatch ? +bottleMatch[1] : 1;

  const COMBO_CARDS = {
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
  ['PENTA','QUAD','TRIPLE_DOUBLE','DOUBLE'].forEach(key=>{
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

let flashTimer = null;
function showComboFlash(combos){
  const el = $('combo-flash');
  if(!el || !combos || !combos.length) return;
  // Build label
  const LABELS = {
    PENTA:'✦ PENTA ✦',
    QUAD:'✦ QUAD ✦',
    TRIPLE_DOUBLE:'✦ TRIPLE + DOUBLE ✦',
    DOUBLE:'✦ DOUBLE ✦',
  };
  // Show the highest impact combo
  const order = ['PENTA','QUAD','TRIPLE_DOUBLE','DOUBLE'];
  const top = order.find(k => combos.includes(k));
  if(!top) return;
  // Clear previous
  clearTimeout(flashTimer);
  el.innerHTML = '';
  const span = document.createElement('div');
  span.className = 'flash-text';
  span.textContent = LABELS[top];
  el.appendChild(span);
  // If multiple combos, show second after first fades
  const second = order.find(k => combos.includes(k) && k!==top);
  if(second){
    flashTimer = setTimeout(()=>{
      el.innerHTML='';
      const s2=document.createElement('div');
      s2.className='flash-text';
      s2.textContent=LABELS[second];
      el.appendChild(s2);
    }, 3700);
  }
}

function bottleSVG(){return '<svg class="bottle-svg" viewBox="0 0 26 52" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="8" y="1" width="10" height="5.5" rx="2.5" fill="#17502a"/><rect x="9.5" y="6" width="7" height="3" rx="1" fill="#17502a"/><path d="M5.5 8.5 C3.5 15 3 21 3 27 C3 41 10.5 49.5 13 50.5 C15.5 49.5 23 41 23 27 C23 21 22.5 15 20.5 8.5 Z" fill="#2a7040"/><path d="M5.5 8.5 C3.5 15 3 21 3 27 C3 39 9 47 12 50" stroke="#3a9054" stroke-width="1.4" fill="none" opacity=".5"/><path d="M7.5 14 C6 19 5.5 24 6 27" stroke="rgba(255,255,255,.09)" stroke-width="1.2" fill="none"/></svg>';}

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
</script>
</body>
</html>`;
