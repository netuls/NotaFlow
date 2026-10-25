// NotaFlow: controle de estoque + entrada por NF-e + baixa automática pelas vendas da Cardápio Web.
// Várias lojas: cada loja tem seu login e seus dados separados. Você cria as lojas em /admin.
// Variáveis:
//   APP_SENHA (obrigatória) ........ senha do painel /admin (onde você cria lojas e logins)
//   FIREBASE_SERVICE_ACCOUNT ....... chave do Firebase (JSON ou base64). Sem ela grava em dados-lojas.json (só para teste)
//   CW_CLIENT_ID + CW_REDIRECT_URI . app OAuth da Cardápio Web | CW_AMBIENTE=sandbox (padrão: producao)
//   Opcionais: SESSION_SECRET, PORT, CW_POLL_SEG (padrão 30), CW_BASE, CW_AUTH_URL
// Rode em UMA instância só: os dados das lojas ficam em memória e são gravados no Firestore.
const http = require('http'), fs = require('fs'), crypto = require('crypto'), { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);
// carrega o arquivo .env (se existir) sem precisar de biblioteca
if (fs.existsSync('.env')) for (const l of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
  if (m && !l.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const E = process.env;
if (!E.APP_SENHA) { console.error('Defina a variável APP_SENHA (senha do painel /admin) antes de iniciar.'); process.exit(1); }
const SANDBOX = E.CW_AMBIENTE === 'sandbox';
const BASE = E.CW_BASE || (SANDBOX ? 'https://integracao.sandbox.cardapioweb.com' : 'https://integracao.cardapioweb.com');
const AUTH_URL = E.CW_AUTH_URL || (SANDBOX ? 'https://portal.sandbox.cardapioweb.com/cw-apps' : 'https://portal.cardapioweb.com/cw-apps');
const CLIENT_ID = E.CW_CLIENT_ID || '', REDIRECT = E.CW_REDIRECT_URI || '';
const API = BASE + '/api/partner/v1';
const b64 = b => Buffer.from(b).toString('base64url');
const esc = t => String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- armazenamento (Firestore, ou arquivo local para teste) ----------
// Aceita o JSON da chave puro, entre aspas, ou convertido em base64 (uma linha só).
function lerChaveFirebase(v) {
  v = String(v || '').trim();
  if (v.length > 1 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1).trim();
  for (const t of [() => v, () => Buffer.from(v, 'base64').toString('utf8')]) {
    try {
      const o = JSON.parse(t());
      if (o && o.private_key && o.client_email) { o.private_key = String(o.private_key).replace(/\\n/g, '\n'); return o; }
    } catch (e) { /* tenta o próximo formato */ }
  }
  return null;
}
let store;
if (E.FIREBASE_SERVICE_ACCOUNT) {
  const chave = lerChaveFirebase(E.FIREBASE_SERVICE_ACCOUNT);
  if (!chave) {
    const v = String(E.FIREBASE_SERVICE_ACCOUNT).trim();
    console.error('ERRO: FIREBASE_SERVICE_ACCOUNT não é a chave de conta de serviço do Firebase.');
    console.error('O valor tem ' + v.length + ' caracteres e começa com "' + v.slice(0, 1) + '". O certo é começar com "{" e conter "private_key" e "client_email".');
    process.exit(1);
  }
  const admin = require('firebase-admin');
  admin.initializeApp({ credential: admin.credential.cert(chave) });
  const fdb = admin.firestore();
  fdb.settings({ ignoreUndefinedProperties: true });
  store = {
    nome: 'Firestore',
    get: async p => { const s = await fdb.doc(p).get(); return s.exists ? s.data() : null; },
    set: async (p, o) => { await fdb.doc(p).set(JSON.parse(JSON.stringify(o))); },
    del: async p => { await fdb.doc(p).delete(); },
    lojas: async () => (await fdb.collection('lojas').get()).docs.map(d => d.data())
  };
} else {
  const ARQ = E.DADOS_ARQ || 'dados-lojas.json';
  const m = fs.existsSync(ARQ) ? JSON.parse(fs.readFileSync(ARQ, 'utf8')) : {};
  const grava = () => { fs.writeFileSync(ARQ + '.tmp', JSON.stringify(m)); fs.renameSync(ARQ + '.tmp', ARQ); };
  const cp = o => JSON.parse(JSON.stringify(o));
  store = {
    nome: 'arquivo local (' + ARQ + ')',
    get: async p => m[p] ? cp(m[p]) : null,
    set: async (p, o) => { m[p] = cp(o); grava(); },
    del: async p => { delete m[p]; grava(); },
    lojas: async () => Object.keys(m).filter(k => /^lojas\/[^/]+$/.test(k)).map(k => cp(m[k]))
  };
}

// Cada loja: lojas/{id} (nome, token da Cardápio Web) + lojas/{id}/dados/{insumos|movs|notas}_{n} + vendas_0.
// As listas são divididas em partes para nunca passar do limite de 1 MB por documento do Firestore.
const LOJAS = new Map();
const novaLoja = cfg => ({ id: cfg.id, cfg, db: null, carregando: null, ult: {}, np: {}, q: Promise.resolve(), rodando: false });
const BLOCOS = { insumos: 'insumos', movs: 'movs', notasLista: 'notas' };
const cam = (L, nome, k) => `lojas/${L.id}/dados/${nome}_${k}`;
const TAM_PARTE = 600000;
function dividir(lista) {
  const partes = []; let atual = [], tam = 0;
  for (const x of lista) {
    const t = Buffer.byteLength(JSON.stringify(x));
    if (atual.length && tam + t > TAM_PARTE) { partes.push(atual); atual = []; tam = 0; }
    atual.push(x); tam += t;
  }
  if (atual.length) partes.push(atual);
  return partes;
}
async function dados(L) {
  if (L.db) return L.db;
  L.carregando ||= (async () => {
    const db = { insumos: [], movs: [], notasLista: [], vendas: {}, cwToken: L.cfg.cwToken || null, vendasCfg: L.cfg.vendasCfg || {} };
    for (const [campo, nome] of Object.entries(BLOCOS)) {
      let k = 0;
      for (; ; k++) { const d = await store.get(cam(L, nome, k)); if (!d) break; db[campo].push(...d.lista); }
      L.np[nome] = k; L.ult[nome] = JSON.stringify(db[campo]);
    }
    const v = await store.get(cam(L, 'vendas', 0)); if (v) db.vendas = v.mapa || {};
    L.ult.vendas = JSON.stringify(db.vendas); L.ult.cfg = JSON.stringify([db.cwToken, db.vendasCfg]);
    L.db = db; return db;
  })();
  try { return await L.carregando; } catch (e) { L.carregando = null; throw e; }
}
async function gravar(L) {
  const db = L.db; if (!db) return;
  for (const [campo, nome] of Object.entries(BLOCOS)) {
    const s = JSON.stringify(db[campo]); if (s === L.ult[nome]) continue;
    const partes = dividir(db[campo]);
    for (let k = 0; k < partes.length; k++) await store.set(cam(L, nome, k), { lista: partes[k] });
    for (let k = partes.length; k < (L.np[nome] || 0); k++) await store.del(cam(L, nome, k));
    L.np[nome] = partes.length; L.ult[nome] = s;
  }
  const sv = JSON.stringify(db.vendas);
  if (sv !== L.ult.vendas) { await store.set(cam(L, 'vendas', 0), { mapa: db.vendas }); L.ult.vendas = sv; }
  const sc = JSON.stringify([db.cwToken, db.vendasCfg]);
  if (sc !== L.ult.cfg) { L.cfg = { ...L.cfg, cwToken: db.cwToken, vendasCfg: db.vendasCfg }; await store.set('lojas/' + L.id, L.cfg); L.ult.cfg = sc; }
}
// grava em fila (uma por vez em cada loja) e devolve o erro a quem chamou, para nunca dizer "salvo" sem ter salvo
function salvar(L) { const p = L.q.then(() => gravar(L)); L.q = p.catch(() => {}); return p; }
function salvarCfg(L) {
  const p = L.q.then(() => store.set('lojas/' + L.id, { ...L.cfg, cwToken: L.db ? L.db.cwToken : L.cfg.cwToken, vendasCfg: L.db ? L.db.vendasCfg : L.cfg.vendasCfg }));
  L.q = p.catch(() => {}); return p;
}

// ---------- usuários e sessão ----------
const chaveUsuario = email => crypto.createHash('sha256').update(norm(email)).digest('hex').slice(0, 32);
const USERS = new Map();
async function getUser(k) { if (USERS.has(k)) return USERS.get(k); const u = await store.get('usuarios/' + k); if (u) USERS.set(k, u); return u; }
const criarHash = async senha => { const s = crypto.randomBytes(16); return s.toString('hex') + ':' + (await scrypt(String(senha), s, 32)).toString('hex'); };
const FALSO = '00'.repeat(16) + ':' + '00'.repeat(32);
async function confere(senha, guardado) {
  const [s, h] = String(guardado).split(':'), esp = Buffer.from(h || '', 'hex');
  const got = await scrypt(String(senha), Buffer.from(s || '', 'hex'), 32);
  return esp.length === 32 && crypto.timingSafeEqual(got, esp);
}
const SEG = E.SESSION_SECRET || crypto.createHash('sha256').update('nf:' + E.APP_SENHA).digest('hex');
const assina = v => crypto.createHmac('sha256', SEG).update(v).digest('base64url');
const igual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const hash = s => crypto.createHash('sha256').update(s).digest();
const emitir = obj => { const p = b64(JSON.stringify(obj)); return p + '.' + assina(p); };
function lerCookie(req, nome) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + nome + '=([^;]+)'));
  if (!m) return null;
  const [p, s] = m[1].split('.');
  if (!p || !s || !igual(s, assina(p))) return null;
  try { const o = JSON.parse(Buffer.from(p, 'base64url').toString()); return o.e > Date.now() ? o : null; } catch (e) { return null; }
}
const setCk = (nome, v, https, max) => `${nome}=${v}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${max}${https ? '; Secure' : ''}`;
async function sessao(req) {
  const o = lerCookie(req, 'nf'); if (!o || !o.k) return null;
  const usr = await getUser(o.k);
  if (!usr || usr.ativo === false || (usr.sv || 0) !== (o.sv || 0)) return null;
  const L = LOJAS.get(o.l);
  if (!L || L.cfg.ativa === false || usr.lojaId !== o.l) return null;
  return { usr, L };
}
const tent = {};
const bloqueado = (...ks) => ks.some(k => { const t = tent[k]; return t && t.n >= (k.startsWith('em:') ? 10 : 5) && Date.now() < t.ate; });
const falhou = (...ks) => { for (const k of ks) { const t = tent[k]; tent[k] = { n: (t && Date.now() < t.ate ? t.n : 0) + 1, ate: Date.now() + 10 * 60e3 }; } };
const limpou = (...ks) => ks.forEach(k => delete tent[k]);
setInterval(() => { for (const k in tent) if (tent[k].ate < Date.now()) delete tent[k]; }, 10 * 60e3).unref();
const seguro = n => /^\/(?![\/\\])/.test(n || '') ? n : '';

// ---------- páginas simples ----------
const ESTILO = `<style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(700px 360px at 85% -10%,rgba(143,211,255,.18),transparent 60%),#07080b;font:15px system-ui,sans-serif;color:#f2f7fb}
.box{background:#0f1217;border:1px solid #1f2630;border-top:3px solid #8fd3ff;padding:26px;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.55)}
h1{margin:0 0 4px;font-size:24px}h1 span{color:#8fd3ff}h2{margin:0 0 12px;font-size:17px}p{margin:0 0 16px;color:#8c9aa8}
input,select{width:100%;padding:10px;border:1px solid #1f2630;background:#07080b;color:#f2f7fb;border-radius:9px;font:inherit;margin-bottom:10px}
button{padding:10px 16px;border:0;border-radius:9px;background:#8fd3ff;color:#06080c;font:inherit;font-weight:700;cursor:pointer}button.sm{padding:5px 11px;font-size:13px}
a{color:#8fd3ff}.e{background:#2d1216;color:#ff7a85;padding:9px 12px;border-radius:9px;margin-bottom:12px;font-weight:600}.ok{background:#0d2a2a;color:#5eead4;padding:9px 12px;border-radius:9px;margin-bottom:12px;font-weight:600}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:8px 6px;border-bottom:1px solid #1f2630;font-size:14px;vertical-align:middle}th{color:#8c9aa8}small{color:#8c9aa8}</style>`;
const centro = c => `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NotaFlow</title>${ESTILO}</head><body style="display:grid;place-items:center">${c}</body></html>`;
const pagina = (erro, next) => centro(`<form class="box" method="post" action="/login" style="width:min(340px,92vw)"><h1>Nota<span>Flow</span></h1><p>Entre com seu e-mail e senha.</p>${erro ? `<div class="e">${esc(erro)}</div>` : ''}<input type="hidden" name="next" value="${esc(next || '')}"><input type="email" name="email" placeholder="E-mail" autocomplete="username" autofocus required><input type="password" name="senha" placeholder="Senha" autocomplete="current-password" required><button style="width:100%">Entrar</button></form>`);
const aviso = (msg, href = '/', link = 'Voltar') => centro(`<div class="box" style="width:min(420px,92vw)"><h1>Nota<span>Flow</span></h1><div class="e" style="margin-top:12px">${esc(msg)}</div><a href="${esc(href)}">${esc(link)}</a></div>`);

// ---------- regras do estoque ----------
const uid = () => crypto.randomBytes(6).toString('hex');
const num = v => Math.round((Number(v) || 0) * 1000) / 1000;
const norm = s => String(s || '').trim().toLowerCase();
const un = u => ['KG', 'L'].includes(String(u).toUpperCase()) ? String(u).toUpperCase() : 'UN';
const falha = m => { const e = new Error(m); e.http = 400; return e; };

function movimentar(db, i, tipo, qtd, extra = {}) {
  const { forcar, ...ex } = extra, q = num(qtd);
  if (tipo === 'saida' && q > i.saldo && !forcar) throw falha(`Saldo insuficiente de ${i.nome} (${i.saldo} ${i.unidade}).`);
  const dif = tipo === 'saida' ? -q : tipo === 'ajuste' ? q - i.saldo : q;
  i.saldo = num(i.saldo + dif);
  db.movs.unshift({ id: uid(), data: new Date().toISOString(), insumoId: i.id, nome: i.nome, unidade: i.unidade, tipo, qtd: num(dif), custo: i.custo, ...ex });
  if (db.movs.length > 2000) db.movs.length = 2000;
}

async function salvarInsumo(L, b, id) {
  const db = L.db;
  if (!norm(b.nome)) throw falha('Informe o nome do insumo.');
  const campos = { nome: String(b.nome).trim(), unidade: un(b.unidade), categoria: String(b.categoria || 'Geral').trim() || 'Geral',
                   custo: num(b.custo), preco: num(b.preco), minimo: num(b.minimo), codigo: String(b.codigo || '').trim(), ean: String(b.ean || '').trim() };
  let i = id && db.insumos.find(x => x.id === id);
  if (id && !i) throw falha('Insumo não encontrado.');
  if (i) Object.assign(i, campos);
  else {
    i = { id: uid(), saldo: 0, ...campos }; db.insumos.push(i);
    if (num(b.saldo) > 0) movimentar(db, i, 'entrada', b.saldo, { obs: 'Saldo inicial' });
  }
  await salvar(L); return i;
}

const eanOk = v => /^\d{8,14}$/.test(String(v || '').trim());
const achar = (db, it) => (eanOk(it.ean) && db.insumos.find(x => x.ean === String(it.ean).trim()))
  || (it.codigo && db.insumos.find(x => x.codigo === String(it.codigo))) || db.insumos.find(x => norm(x.nome) === norm(it.nome));

async function entradaNota(L, { chave, fornecedor, itens }) {
  const db = L.db;
  if (chave && db.notasLista.some(n => n.chave === chave && !n.estornada)) throw falha('Esta nota já foi lançada.');
  if (!itens || !itens.length) throw falha('Nenhum item para lançar.');
  for (const it of itens) if (!(Number(it.qtd) > 0)) throw falha(`Quantidade inválida em "${it.nome}".`);
  const id = uid(), res = [], reg = [];
  for (const it of itens) {
    let i = achar(db, it);
    const novo = !i, q = num(it.qtd), c = num(it.custo);
    if (novo) { i = { id: uid(), saldo: 0, minimo: 0, nome: it.nome, unidade: un(it.unidade), categoria: it.categoria || 'Geral', custo: 0, preco: 0, codigo: String(it.codigo || ''), ean: '' }; db.insumos.push(i); }
    const custoAnt = i.custo, base = Math.max(i.saldo, 0);
    i.custo = (!custoAnt || base + q <= 0) ? c : num((base * custoAnt + q * c) / (base + q));   // custo médio ponderado
    if (!i.codigo && it.codigo) i.codigo = String(it.codigo);
    if (!i.ean && eanOk(it.ean)) i.ean = String(it.ean).trim();
    movimentar(db, i, 'entrada', q, { custo: c, custoAnt, nota: chave || '', obs: fornecedor ? 'NF-e ' + fornecedor : 'NF-e' });
    reg.push({ insumoId: i.id, nome: i.nome, unidade: i.unidade, qtd: q, custo: c, custoAnt });
    res.push({ nome: i.nome, acao: novo ? 'cadastrado' : 'saldo somado', saldo: i.saldo, unidade: i.unidade });
  }
  db.notasLista.unshift({ id, chave: chave || '', fornecedor: fornecedor || '', data: new Date().toISOString(),
    total: num(reg.reduce((a, x) => a + x.qtd * x.custo, 0)), itens: reg, estornada: false });
  await salvar(L); return res;
}

async function estornarNota(L, id) {
  const db = L.db;
  const n = db.notasLista.find(x => x.id === id);
  if (!n) throw falha('Nota não encontrada.');
  if (n.estornada) throw falha('Esta nota já foi estornada.');
  if (n.legado || !n.itens.length) throw falha('Esta nota é antiga e não tem os itens guardados. Corrija o saldo com ajustes.');
  const linhas = n.itens.map(it => ({ it, i: db.insumos.find(x => x.id === it.insumoId) })).filter(l => l.i);
  const falta = linhas.filter(l => l.i.saldo < l.it.qtd).map(l => `${l.i.nome} (saldo ${l.i.saldo}, a retirar ${l.it.qtd})`);
  if (falta.length) throw falha('Não dá para estornar porque estes itens já tiveram saída: ' + falta.join('; ') + '. Ajuste o saldo antes.');
  for (const { it, i } of linhas) {
    const resto = num(i.saldo - it.qtd);
    if (resto > 0) i.custo = Math.max(0, num((i.saldo * i.custo - it.qtd * it.custo) / resto));   // desfaz o custo médio
    else if (it.custoAnt != null) i.custo = it.custoAnt;
    movimentar(db, i, 'saida', it.qtd, { custo: it.custo, estornoNota: n.id, obs: 'Estorno da nota ' + (n.fornecedor || n.chave.slice(-8)) });
  }
  n.estornada = true; n.estornadaEm = new Date().toISOString();
  await salvar(L); return n;
}

async function saidas(L, { itens, obs }) {
  const db = L.db;
  if (!itens || !itens.length) throw falha('Nenhum item na saída.');
  const lin = itens.map(it => {
    const i = db.insumos.find(x => x.id === it.insumoId); if (!i) throw falha('Insumo não encontrado.');
    const q = num(it.qtd); if (!(q > 0)) throw falha(`Quantidade inválida em ${i.nome}.`);
    return { i, q };
  });
  const tot = new Map(); for (const { i, q } of lin) tot.set(i, (tot.get(i) || 0) + q);
  for (const [i, q] of tot) if (q > i.saldo) throw falha(`Saldo insuficiente de ${i.nome} (${i.saldo} ${i.unidade}).`);
  for (const { i, q } of lin) movimentar(db, i, 'saida', q, { obs: String(obs || 'Saída rápida').slice(0, 120) });
  await salvar(L); return { ok: true, itens: lin.length };
}

async function inventario(L, { itens }) {
  const db = L.db;
  if (!itens || !itens.length) throw falha('Nenhum item contado.');
  const lin = itens.map(it => {
    const i = db.insumos.find(x => x.id === it.insumoId); if (!i) throw falha('Insumo não encontrado.');
    const c = Number(it.contado); if (!(c >= 0)) throw falha(`Contagem inválida em ${i.nome}.`);
    return { i, c: num(c) };
  });
  let ajustados = 0;
  for (const { i, c } of lin) if (c !== i.saldo) { movimentar(db, i, 'ajuste', c, { obs: 'Contagem de inventário' }); ajustados++; }
  await salvar(L); return { contados: lin.length, ajustados };
}

// ---------- baixa automática pelas vendas da Cardápio Web (uma conexão por loja) ----------
const BAIXA = ['confirmed', 'scheduled_confirmed', 'ready', 'released', 'waiting_to_catch', 'delivered', 'closed'];
const temAcesso = db => !!db.cwToken;
async function trocarToken(L, params) {
  const db = L.db;
  const r = await fetch(BASE + '/api/partner/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) { if (params.grant_type === 'refresh_token' && r.status < 500) { db.cwToken = null; await salvar(L); } throw new Error('Token da Cardápio Web: ' + (j.error_description || j.error || j.message || r.status)); }
  db.cwToken = { access: j.access_token, refresh: j.refresh_token || (db.cwToken && db.cwToken.refresh), expira: Date.now() + ((Number(j.expires_in) || 7200) - 120) * 1000, scope: j.scope || '' };
  await salvar(L);
}
async function cw(L, path, retry = true) {
  const db = L.db;
  if (!db.cwToken) throw new Error('Cardápio Web não conectada.');
  if (db.cwToken && Date.now() > db.cwToken.expira && db.cwToken.refresh) await trocarToken(L, { grant_type: 'refresh_token', refresh_token: db.cwToken.refresh });
  const oauth = !!db.cwToken;
  const r = await fetch(API + path, { headers: { Authorization: 'Bearer ' + db.cwToken.access } });
  if (r.status === 401 && oauth && retry && db.cwToken.refresh) { await trocarToken(L, { grant_type: 'refresh_token', refresh_token: db.cwToken.refresh }); return cw(L, path, false); }
  const t = await r.text();
  if (!r.ok) throw new Error(`Cardápio Web respondeu ${r.status}` + (r.status === 401 ? ' (chave/token inválido: reconecte ou confira a chave)' : r.status === 403 ? ' (o app não tem a permissão de Pedidos)' : '') + ': ' + t.slice(0, 150));
  return JSON.parse(t);
}
function consumo(pedido) {
  const out = [];
  const visita = (it, mult) => {
    if (it.status === 'canceled') return;
    const q = (Number(it.quantity) || 0) * mult;
    if (it.kind === 'combo') { (it.items || []).forEach(f => visita(f, q)); return; }
    out.push({ codigo: it.external_code ? String(it.external_code) : '', nome: it.name, qtd: q, opcao: false });
    for (const o of it.options || []) out.push({ codigo: o.external_code ? String(o.external_code) : '', nome: o.name, qtd: q * (Number(o.quantity) || 0), opcao: true });
  };
  (pedido.items || []).forEach(it => visita(it, 1));
  return out;
}
function vincular(db, c) {
  if (c.codigo) { const i = db.insumos.find(x => (x.codigo && x.codigo === c.codigo) || (x.ean && x.ean === c.codigo)); if (i) return i; }
  return c.opcao ? null : db.insumos.find(x => norm(x.nome) === norm(c.nome)) || null;
}
function baixarPedido(db, p) {
  const por = {}, sem = [];
  for (const c of consumo(p)) {
    const i = vincular(db, c);
    if (!i) { if (!c.opcao) sem.push(c.nome); continue; }
    por[i.id] = (por[i.id] || 0) + c.qtd;
  }
  const baixas = [];
  for (const [id, q] of Object.entries(por)) {
    const i = db.insumos.find(x => x.id === id);
    if (q > 0) { movimentar(db, i, 'saida', q, { forcar: true, obs: `Venda Cardápio Web #${p.display_id || p.id}`, pedido: p.id }); baixas.push({ insumoId: id, qtd: num(q) }); }
  }
  db.vendas[p.id] = { display: p.display_id || p.id, status: p.status, data: new Date().toISOString(), baixas, semVinculo: [...new Set(sem)], estornado: false };
}
function estornarPedido(db, id) {
  const v = db.vendas[id];
  for (const b of v.baixas) { const i = db.insumos.find(x => x.id === b.insumoId); if (i) movimentar(db, i, 'entrada', b.qtd, { obs: `Cancelamento Cardápio Web #${v.display}`, pedido: id }); }
  v.estornado = true; v.status = 'canceled';
}
async function sincronizarVendas(L) {
  const db = await dados(L);
  if (!temAcesso(db) || L.rodando) return db.vendasCfg;
  L.rodando = true;
  const cfg = db.vendasCfg, inicioCiclo = Date.now();
  try {
    if (!cfg.inicio) cfg.inicio = new Date().toISOString();   // só pedidos criados a partir daqui entram
    const desde = Math.max(Date.parse(cfg.ultimo || cfg.inicio) - 120e3, Date.now() - 23 * 3600e3);
    const lista = await cw(L, '/orders?updated_since=' + encodeURIComponent(new Date(desde).toISOString()));
    const pedidos = Array.isArray(lista) ? lista : (lista.data || lista.orders || []);
    let baixados = 0, estornados = 0;
    for (const lite of pedidos) {
      const v = db.vendas[lite.id];
      if (v && !v.estornado && lite.status === 'canceled') { estornarPedido(db, lite.id); estornados++; await salvar(L); continue; }
      if (v || !BAIXA.includes(lite.status) || Date.parse(lite.created_at) < Date.parse(cfg.inicio)) continue;
      baixarPedido(db, await cw(L, '/orders/' + lite.id)); baixados++; await salvar(L);
    }
    cfg.ultimo = new Date(inicioCiclo).toISOString(); cfg.erro = null; cfg.ultimaExecucao = new Date().toISOString();
    cfg.ultimoResumo = { vistos: pedidos.length, baixados, estornados };
    const ids = Object.keys(db.vendas); if (ids.length > 1500) ids.slice(0, ids.length - 1500).forEach(k => delete db.vendas[k]);
    await salvar(L);
  } catch (e) { cfg.erro = e.message; cfg.ultimaExecucao = new Date().toISOString(); console.error('Vendas:', e.message); }
  finally { L.rodando = false; }
  return cfg;
}
const statusVendas = db => ({ ativo: temAcesso(db), conectado: !!db.cwToken, modo: db.cwToken ? 'oauth' : '', podeConectar: !!(CLIENT_ID && REDIRECT), ...db.vendasCfg,
  semVinculo: [...new Set(Object.values(db.vendas).flatMap(v => v.semVinculo || []))].slice(0, 30),
  recentes: Object.values(db.vendas).sort((a, b) => b.data.localeCompare(a.data)).slice(0, 15).map(v => ({ display: v.display, data: v.data, estornado: v.estornado, itens: v.baixas.length })) });

const paginaVendas = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vendas — NotaFlow</title>
<style>:root{color-scheme:dark}body{margin:0;background:radial-gradient(900px 420px at 88% -8%,rgba(143,211,255,.16),transparent 60%),#07080b;color:#f2f7fb;font:15px/1.5 "Segoe UI",system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:28px 16px}a{color:#8fd3ff}h1{margin:6px 0 16px;font-size:26px}.card{background:#0f1217;border:1px solid #1f2630;border-radius:14px;padding:18px;margin-bottom:16px}
.mut{color:#8c9aa8}.tag{display:inline-block;padding:2px 10px;border-radius:99px;font-size:12px;font-weight:700}.ok{background:#0d2a2a;color:#5eead4}.wa{background:#2d2410;color:#ffd166}.er{background:#2d1216;color:#ff7a85}
button{font:inherit;font-weight:700;border:0;background:#8fd3ff;color:#06080c;padding:9px 16px;border-radius:9px;cursor:pointer}button:disabled{opacity:.55}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:7px 6px;border-bottom:1px solid #1f2630;font-size:14px}th{color:#8c9aa8}.msg{margin:12px 0;padding:10px 14px;border-radius:10px;background:#2d1216;color:#ff7a85;font-weight:600}</style></head>
<body><main><a href="/">← Voltar ao NotaFlow</a><h1>Vendas da Cardápio Web</h1>
<div class="card"><p class="mut" style="margin-top:0">O NotaFlow consulta os pedidos a cada 30 segundos e dá baixa no estoque quando o pedido é confirmado. Pedido cancelado devolve o saldo. O produto é ligado ao insumo pelo código externo do cardápio (igual ao código ou EAN do insumo) ou, sem código, pelo mesmo nome.</p>
<p><span class="tag" id="tag"></span></p><div id="info"></div><p><button id="b">Verificar pedidos agora</button> <a href="/oauth/login" id="cx" hidden style="display:inline-block;background:#13222e;color:#8fd3ff;font-weight:700;padding:9px 16px;border-radius:9px;text-decoration:none"></a></p></div>
<div class="card"><h2 style="margin-top:0;font-size:17px">Últimas baixas</h2><div id="rec"></div></div>
<div class="card" id="semc" hidden><h2 style="margin-top:0;font-size:17px">Vendidos sem insumo correspondente (sem baixa)</h2><p class="mut" style="margin-top:0">Cadastre um insumo com o mesmo código (ou nome) do produto.</p><div id="sem"></div></div></main>
<script>
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const dt=d=>d?new Date(d).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'}):'–';
async function ld(){const r=await fetch('/api/vendas');if(r.status===401){location='/login';return}const V=await r.json(),t=document.getElementById('tag');
 t.className='tag '+(V.ativo?(V.erro?'wa':'ok'):'wa');t.textContent=V.ativo?(V.erro?'Erro na última consulta':'Ligada'):'Desligada';
 document.getElementById('b').hidden=!V.ativo;document.getElementById('cx').hidden=!V.podeConectar;document.getElementById('cx').textContent=V.conectado?'Reconectar à Cardápio Web':'Conectar à Cardápio Web';
 document.getElementById('info').innerHTML=!V.ativo?'<p class="mut">Ainda não conectado. '+(V.podeConectar?'Clique em Conectar à Cardápio Web (entre com a conta de Proprietário da loja).':'A conexão com a Cardápio Web ainda não foi configurada no servidor (CW_CLIENT_ID e CW_REDIRECT_URI).')+'</p>':(V.erro?'<div class="msg">'+esc(V.erro)+'</div>':'')+(V.ultimaExecucao?'<p class="mut">Última consulta: '+dt(V.ultimaExecucao)+(V.ultimoResumo?' · '+V.ultimoResumo.baixados+' baixados, '+V.ultimoResumo.estornados+' devolvidos':'')+'</p>':'')+(V.inicio?'<p class="mut">Só entram pedidos criados depois de '+dt(V.inicio)+'.</p>':'');
 document.getElementById('rec').innerHTML=V.recentes.length?'<table><tr><th>Pedido</th><th>Data</th><th>Itens</th><th></th></tr>'+V.recentes.map(v=>'<tr><td>#'+esc(v.display)+'</td><td>'+dt(v.data)+'</td><td>'+v.itens+'</td><td>'+(v.estornado?'<span class="tag er">Cancelado</span>':'<span class="tag ok">Baixado</span>')+'</td></tr>').join('')+'</table>':'<p class="mut">Nenhuma venda baixada ainda.</p>';
 document.getElementById('semc').hidden=!V.semVinculo.length;document.getElementById('sem').textContent=V.semVinculo.join(', ');}
document.getElementById('b').onclick=async()=>{const b=document.getElementById('b');b.disabled=true;b.textContent='Consultando…';await fetch('/api/vendas/verificar',{method:'POST'});await ld();b.disabled=false;b.textContent='Verificar pedidos agora'};
ld();setInterval(ld,15000);
</script></body></html>`;

// ---------- painel /admin: você cria as lojas e os logins ----------
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
async function criarUsuario(L, email, senha) {
  email = norm(email);
  if (!emailOk(email)) throw falha('E-mail inválido.');
  if (String(senha || '').length < 8) throw falha('A senha precisa ter pelo menos 8 caracteres.');
  const k = chaveUsuario(email);
  if (await getUser(k)) throw falha('Esse e-mail já tem cadastro.');
  const u = { email, lojaId: L.id, senha: await criarHash(senha), sv: 0, ativo: true, criado: new Date().toISOString() };
  await store.set('usuarios/' + k, u); USERS.set(k, u);
  L.cfg = { ...L.cfg, usuarios: [...(L.cfg.usuarios || []), email] }; await salvarCfg(L);
}
function paginaAdmin(msg, tipo) {
  const ls = [...LOJAS.values()].sort((a, b) => String(a.cfg.criada).localeCompare(String(b.cfg.criada)));
  const lin = ls.map(L => { const off = L.cfg.ativa === false; return `<tr><td>${esc(L.cfg.nome)}<br><small>${esc((L.cfg.usuarios || []).join(', '))}</small></td><td>${L.cfg.cwToken ? 'Conectada' : '–'}</td><td>${off ? 'Desativada' : 'Ativa'}</td>
    <td><form method="post" action="/admin/ativa"><input type="hidden" name="lojaId" value="${L.id}"><input type="hidden" name="ativa" value="${off ? 1 : 0}"><button class="sm">${off ? 'Reativar' : 'Desativar'}</button></form></td></tr>`; }).join('');
  const opt = ls.map(L => `<option value="${L.id}">${esc(L.cfg.nome)}</option>`).join('');
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Painel — NotaFlow</title>${ESTILO}</head><body><main style="max-width:860px;margin:0 auto;padding:24px 16px">
<div style="display:flex;justify-content:space-between;align-items:center"><h1>Nota<span>Flow</span> · painel</h1><a href="/admin/sair">Sair do painel</a></div>
${msg ? `<div class="${tipo === 'ok' ? 'ok' : 'e'}" style="margin-top:12px">${esc(msg)}</div>` : ''}
<div class="box" style="margin:16px 0"><h2>Lojas (${ls.length})</h2>${ls.length ? `<table><tr><th>Loja / logins</th><th>Cardápio Web</th><th>Situação</th><th></th></tr>${lin}</table>` : '<p>Nenhuma loja ainda.</p>'}</div>
<div class="box" style="margin-bottom:16px"><h2>Nova loja</h2><form method="post" action="/admin/loja"><input name="nome" placeholder="Nome da loja" required><input type="email" name="email" placeholder="E-mail de login" required><input type="text" name="senha" placeholder="Senha inicial (mínimo 8 caracteres)" required minlength="8" autocomplete="off">
<label style="display:block;margin-bottom:10px;color:#8c9aa8"><input type="checkbox" name="importar" value="1" style="width:auto;margin:0 6px 0 0">Importar os dados do NotaFlow de uma loja só (use só na sua primeira loja)</label><button>Criar loja</button></form></div>
<div class="box" style="margin-bottom:16px"><h2>Novo login para uma loja</h2><form method="post" action="/admin/usuario"><select name="lojaId" required>${opt}</select><input type="email" name="email" placeholder="E-mail de login" required><input type="text" name="senha" placeholder="Senha (mínimo 8 caracteres)" required minlength="8" autocomplete="off"><button>Criar login</button></form></div>
<div class="box"><h2>Redefinir senha</h2><form method="post" action="/admin/senha"><input type="email" name="email" placeholder="E-mail do login" required><input type="text" name="senha" placeholder="Nova senha (mínimo 8 caracteres)" required minlength="8" autocomplete="off"><button>Redefinir</button></form><p style="margin:10px 0 0">Quem estava logado com a senha antiga é desconectado.</p></div>
</main></body></html>`;
}
async function admin(req, res, u, ip, https) {
  const volta = (m, t) => { res.writeHead(302, { Location: '/admin?m=' + encodeURIComponent(m) + '&t=' + t }); res.end(); };
  if (u.pathname === '/admin/login' && req.method === 'POST') {
    if (bloqueado('ip:' + ip)) return html(res, 429, aviso('Muitas tentativas. Aguarde 10 minutos.', '/admin'));
    const senha = new URLSearchParams(await corpo(req)).get('senha') || '';
    if (!igual(hash(senha).toString('hex'), hash(E.APP_SENHA).toString('hex'))) { falhou('ip:' + ip); return html(res, 401, aviso('Senha do painel incorreta.', '/admin', 'Tentar de novo')); }
    limpou('ip:' + ip);
    res.writeHead(302, { Location: '/admin', 'Set-Cookie': setCk('nfa', emitir({ a: 1, e: Date.now() + 8 * 3600e3 }), https, 8 * 3600) }); return res.end();
  }
  if (u.pathname === '/admin/sair') { res.writeHead(302, { Location: '/admin', 'Set-Cookie': setCk('nfa', '', https, 0) }); return res.end(); }
  if (!lerCookie(req, 'nfa')) return html(res, 200, centro(`<form class="box" method="post" action="/admin/login" style="width:min(340px,92vw)"><h1>Nota<span>Flow</span></h1><p>Painel do administrador.</p><input type="password" name="senha" placeholder="Senha do painel" autofocus required><button style="width:100%">Entrar</button></form>`));
  if (u.pathname === '/admin' && req.method === 'GET') return html(res, 200, paginaAdmin(u.searchParams.get('m') || '', u.searchParams.get('t') || ''));
  if (req.method !== 'POST') return json(res, 404, { erro: 'não encontrado' });
  const f = new URLSearchParams(await corpo(req));
  try {
    if (u.pathname === '/admin/loja') {
      const nome = String(f.get('nome') || '').trim();
      if (!nome) throw falha('Informe o nome da loja.');
      const email = norm(f.get('email'));
      if (!emailOk(email)) throw falha('E-mail inválido.');
      if (String(f.get('senha') || '').length < 8) throw falha('A senha precisa ter pelo menos 8 caracteres.');
      if (await getUser(chaveUsuario(email))) throw falha('Esse e-mail já tem cadastro.');
      const L = novaLoja({ id: uid(), nome, criada: new Date().toISOString(), ativa: true, usuarios: [] });
      L.cfg.importado = false;
      if (f.get('importar')) {
        const v = await store.get('notaflow/estado');
        if (!v) throw falha('Não achei dados antigos para importar (documento notaflow/estado).');
        L.db = { insumos: v.insumos || [], movs: v.movs || [], notasLista: v.notasLista || [], vendas: v.vendas || {}, cwToken: v.cwToken || null, vendasCfg: v.vendasCfg || {} };
        L.cfg.importado = true;
      }
      await salvarCfg(L);
      if (L.db) await salvar(L);
      LOJAS.set(L.id, L);
      await criarUsuario(L, email, f.get('senha'));
      return volta('Loja criada: ' + nome + (L.cfg.importado ? ' (dados antigos importados)' : ''), 'ok');
    }
    if (u.pathname === '/admin/usuario') {
      const L = LOJAS.get(f.get('lojaId')); if (!L) throw falha('Loja não encontrada.');
      await criarUsuario(L, f.get('email'), f.get('senha')); return volta('Login criado.', 'ok');
    }
    if (u.pathname === '/admin/senha') {
      const k = chaveUsuario(f.get('email')), usr = await getUser(k);
      if (!usr) throw falha('Não existe login com esse e-mail.');
      if (String(f.get('senha') || '').length < 8) throw falha('A senha precisa ter pelo menos 8 caracteres.');
      const novo = { ...usr, senha: await criarHash(f.get('senha')), sv: (usr.sv || 0) + 1 };
      await store.set('usuarios/' + k, novo); USERS.set(k, novo); return volta('Senha redefinida.', 'ok');
    }
    if (u.pathname === '/admin/ativa') {
      const L = LOJAS.get(f.get('lojaId')); if (!L) throw falha('Loja não encontrada.');
      L.cfg = { ...L.cfg, ativa: f.get('ativa') === '1' }; await salvarCfg(L);
      return volta(L.cfg.ativa ? 'Loja reativada.' : 'Loja desativada. Os logins dela não entram mais.', 'ok');
    }
  } catch (e) { if (e.http) return volta(e.message, 'er'); throw e; }
  json(res, 404, { erro: 'não encontrado' });
}

// ---------- servidor ----------
const corpo = req => new Promise(ok => { let b = ''; req.on('data', c => { b += c; if (b.length > 8e6) req.destroy(); }); req.on('end', () => ok(b)); });
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const html = (res, code, s) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(s); };
// acrescenta o atalho "Vendas Cardápio Web" no menu lateral, sem precisar editar o index.html
const LINK_VENDAS = '<a href="/vendas"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h2l2.4 11h10.2L20 7H6M9 20h.01M17 20h.01"/></svg><span>Vendas Cardápio Web</span></a></nav>';

const pend = {};
const servidor = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const https = req.headers['x-forwarded-proto'] === 'https';
  try {
    if (u.pathname === '/login') {
      const next = seguro(u.searchParams.get('next'));
      if (req.method !== 'POST') return html(res, 200, pagina('', next));
      const f = new URLSearchParams(await corpo(req)), email = norm(f.get('email')), nx = seguro(f.get('next')), k = chaveUsuario(email);
      if (bloqueado('ip:' + ip, 'em:' + k)) return html(res, 429, pagina('Muitas tentativas. Aguarde 10 minutos.', nx));
      const usr = email ? await getUser(k) : null;
      const ok = await confere(f.get('senha') || '', usr ? usr.senha : FALSO);
      if (!usr || !ok || usr.ativo === false) { falhou('ip:' + ip, 'em:' + k); return html(res, 401, pagina('E-mail ou senha incorretos.', nx)); }
      const L = LOJAS.get(usr.lojaId);
      if (!L || L.cfg.ativa === false) return html(res, 403, pagina('Esta conta está desativada. Fale com o suporte.', nx));
      limpou('ip:' + ip, 'em:' + k);
      res.writeHead(302, { Location: nx || '/', 'Set-Cookie': setCk('nf', emitir({ k, l: L.id, sv: usr.sv || 0, e: Date.now() + 30 * 864e5 }), https, 2592000) });
      return res.end();
    }
    if (u.pathname === '/sair') { res.writeHead(302, { Location: '/login', 'Set-Cookie': setCk('nf', '', https, 0) }); return res.end(); }
    if (u.pathname.startsWith('/admin')) return await admin(req, res, u, ip, https);
    if (u.pathname === '/oauth/callback') {   // volta da Cardápio Web: o "state" diz de qual loja é a conexão
      const st = u.searchParams.get('state'), p = pend[st];
      if (u.searchParams.get('error')) return html(res, 400, aviso('A Cardápio Web não autorizou: ' + u.searchParams.get('error') + '. Entre com a conta de Proprietário e tente de novo.', '/vendas'));
      if (!p || p.ate < Date.now()) return html(res, 400, aviso('Link expirado. Volte em Vendas e clique em Conectar de novo.', '/vendas'));
      delete pend[st];
      const L = LOJAS.get(p.lojaId); if (!L) return html(res, 400, aviso('Loja não encontrada.', '/'));
      await dados(L);
      try { await trocarToken(L, { grant_type: 'authorization_code', code: u.searchParams.get('code'), redirect_uri: REDIRECT, code_verifier: p.verifier }); }
      catch (e) { return html(res, 400, aviso(e.message, '/vendas')); }
      sincronizarVendas(L).catch(e => console.error('Vendas:', e.message));
      res.writeHead(302, { Location: '/vendas' }); return res.end();
    }
    const ctx = await sessao(req);
    if (!ctx) {
      if (u.pathname.startsWith('/api/')) return json(res, 401, { erro: 'Entre com seu e-mail e senha primeiro.' });
      res.writeHead(302, { Location: '/login' + (req.method === 'GET' && u.pathname !== '/' ? '?next=' + encodeURIComponent(u.pathname) : '') }); return res.end();
    }
    const L = ctx.L, db = await dados(L);

    if (u.pathname === '/') return html(res, 200, fs.readFileSync('index.html', 'utf8').replace('</nav>', LINK_VENDAS));
    if (u.pathname === '/vendas') return html(res, 200, paginaVendas);
    if (u.pathname === '/oauth/login') {
      if (!CLIENT_ID || !REDIRECT) return html(res, 400, aviso('Defina CW_CLIENT_ID e CW_REDIRECT_URI no servidor.'));
      const verifier = b64(crypto.randomBytes(32)), state = b64(crypto.randomBytes(16));
      for (const k in pend) if (pend[k].ate < Date.now()) delete pend[k];
      pend[state] = { verifier, lojaId: L.id, ate: Date.now() + 10 * 60e3 };
      const q = new URLSearchParams({ client_id: CLIENT_ID, state, redirect_uri: REDIRECT, code_challenge: b64(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' });
      res.writeHead(302, { Location: AUTH_URL + '?' + q }); return res.end();
    }
    if (u.pathname === '/api/vendas') return json(res, 200, statusVendas(db));
    if (u.pathname === '/api/vendas/verificar' && req.method === 'POST') { if (!temAcesso(db)) throw falha('Conecte à Cardápio Web primeiro.'); await sincronizarVendas(L); return json(res, 200, statusVendas(db)); }
    if (u.pathname === '/api/estado') return json(res, 200, { loja: L.cfg.nome, insumos: db.insumos, movs: db.movs, notas: db.notasLista });
    if (u.pathname === '/api/backup') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="notaflow-backup-${new Date().toISOString().slice(0, 10)}.json"` });
      return res.end(JSON.stringify({ loja: L.cfg.nome, insumos: db.insumos, movs: db.movs, notasLista: db.notasLista, vendas: db.vendas, vendasCfg: db.vendasCfg }, null, 2));
    }
    if (u.pathname === '/api/insumos' && req.method === 'POST') return json(res, 200, await salvarInsumo(L, JSON.parse(await corpo(req) || '{}')));
    const m = u.pathname.match(/^\/api\/insumos\/([a-f0-9]+)$/);
    if (m && req.method === 'PUT') return json(res, 200, await salvarInsumo(L, JSON.parse(await corpo(req) || '{}'), m[1]));
    if (m && req.method === 'DELETE') { db.insumos = db.insumos.filter(x => x.id !== m[1]); await salvar(L); return json(res, 200, { ok: true }); }
    if (u.pathname === '/api/movimento' && req.method === 'POST') {
      const b = JSON.parse(await corpo(req) || '{}');
      const i = db.insumos.find(x => x.id === b.insumoId);
      if (!i) throw falha('Insumo não encontrado.');
      if (!['entrada', 'saida', 'ajuste'].includes(b.tipo)) throw falha('Tipo inválido.');
      if (!(Number(b.qtd) >= 0) || (b.tipo !== 'ajuste' && !(Number(b.qtd) > 0))) throw falha('Informe uma quantidade válida.');
      movimentar(db, i, b.tipo, b.qtd, { obs: String(b.obs || '').slice(0, 120) });
      await salvar(L); return json(res, 200, i);
    }
    if (u.pathname === '/api/nota' && req.method === 'POST') return json(res, 200, await entradaNota(L, JSON.parse(await corpo(req) || '{}')));
    const mn = u.pathname.match(/^\/api\/notas\/([a-f0-9]+)\/estornar$/);
    if (mn && req.method === 'POST') return json(res, 200, await estornarNota(L, mn[1]));
    if (u.pathname === '/api/saidas' && req.method === 'POST') return json(res, 200, await saidas(L, JSON.parse(await corpo(req) || '{}')));
    if (u.pathname === '/api/inventario' && req.method === 'POST') return json(res, 200, await inventario(L, JSON.parse(await corpo(req) || '{}')));
    json(res, 404, { erro: 'não encontrado' });
  } catch (e) { if (!e.http) console.error('Erro:', e); json(res, e.http || 500, { erro: e.http ? e.message : 'Erro interno. Tente de novo.' }); }
});

let ciclo = false;
async function cicloVendas() {
  if (ciclo) return; ciclo = true;
  try {
    for (const L of LOJAS.values()) {
      if (L.cfg.ativa === false || !(L.db ? L.db.cwToken : L.cfg.cwToken)) continue;
      await sincronizarVendas(L).catch(e => console.error('Vendas (' + L.cfg.nome + '):', e.message));
    }
  } finally { ciclo = false; }
}
process.on('unhandledRejection', e => console.error('Promessa rejeitada:', e && e.message || e));
process.on('SIGTERM', async () => { await Promise.all([...LOJAS.values()].map(L => L.q)); process.exit(0); });
(async () => {
  for (const cfg of await store.lojas()) LOJAS.set(cfg.id, novaLoja(cfg));
  servidor.listen(E.PORT || 3000, () => {
    console.log('NotaFlow na porta ' + (E.PORT || 3000) + ' · ' + LOJAS.size + ' loja(s) · armazenamento: ' + store.nome);
    if (store.nome !== 'Firestore') console.warn('ATENÇÃO: sem FIREBASE_SERVICE_ACCOUNT os dados ficam em arquivo e se perdem no Render. Use só para teste.');
    console.log(CLIENT_ID && REDIRECT ? 'Conexão com a Cardápio Web (OAuth) disponível. Consulta a cada ' + (E.CW_POLL_SEG || 30) + 's.' : 'Defina CW_CLIENT_ID e CW_REDIRECT_URI para ligar a Cardápio Web.');
    setInterval(cicloVendas, Math.max(10, Number(E.CW_POLL_SEG) || 30) * 1000); cicloVendas();
  });
})().catch(e => { console.error('Falha ao iniciar:', e.message); process.exit(1); });
