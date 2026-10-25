// NotaFlow: controle de estoque + entrada por NF-e + baixa automática pelas vendas da Cardápio Web
// Variáveis: APP_SENHA (obrigatória) | FIREBASE_SERVICE_ACCOUNT (JSON; sem ela grava em dados.json) | Outras: SESSION_SECRET, PORT
// Baixa de vendas (opcional), de duas formas:
//   OAuth (recomendado, app da CW App Store): CW_CLIENT_ID + CW_REDIRECT_URI (idêntica à cadastrada no app) | CW_AMBIENTE=sandbox (padrão: producao)
//   Chave antiga (legado): CW_API_KEY
// Outras: CW_POLL_SEG (padrão 30), CW_BASE, CW_AUTH_URL
const http = require('http'), fs = require('fs'), crypto = require('crypto');
// carrega o arquivo .env (se existir) sem precisar de biblioteca
if (fs.existsSync('.env')) for (const l of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
  if (m && !l.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const E = process.env;
if (!E.APP_SENHA) { console.error('Defina a variável APP_SENHA antes de iniciar.'); process.exit(1); }
const API_KEY = E.CW_API_KEY || '';
const SANDBOX = E.CW_AMBIENTE === 'sandbox';
const BASE = E.CW_BASE || (SANDBOX ? 'https://integracao.sandbox.cardapioweb.com' : 'https://integracao.cardapioweb.com');
const AUTH_URL = E.CW_AUTH_URL || (SANDBOX ? 'https://portal.sandbox.cardapioweb.com/cw-apps' : 'https://portal.cardapioweb.com/cw-apps');
const CLIENT_ID = E.CW_CLIENT_ID || '', REDIRECT = E.CW_REDIRECT_URI || '';
const API = BASE + '/api/partner/v1';

// ---------- armazenamento ----------
const ARQ = 'dados.json';
let ref = null;
if (E.FIREBASE_SERVICE_ACCOUNT) {
  const admin = require('firebase-admin');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(E.FIREBASE_SERVICE_ACCOUNT)) });
  ref = admin.firestore().doc('notaflow/estado');
}
let db = { insumos: [], movs: [], notas: [], notasLista: [], migrado: false, vendas: {}, vendasCfg: {}, cwToken: null };
async function carregar() {
  if (ref) { const s = await ref.get(); if (s.exists) db = { ...db, ...s.data() }; }
  else if (fs.existsSync(ARQ)) db = { ...db, ...JSON.parse(fs.readFileSync(ARQ)) };
  delete db.token;                       // restos da antiga sincronização
  if (migrar()) await save();
}
// Versões antigas guardavam só a chave das notas: reconstrói a lista de notas a partir das movimentações.
function migrar() {
  if (db.migrado) return false;
  const por = {};
  for (const m of [...db.movs].reverse()) if (m.nota && m.tipo === 'entrada') (por[m.nota] ||= []).push(m);
  for (const [chave, ms] of Object.entries(por)) {
    const itens = ms.map(m => ({ insumoId: m.insumoId, nome: m.nome, unidade: m.unidade, qtd: m.qtd, custo: m.custo || 0 }));
    db.notasLista.unshift({ id: uid(), chave, fornecedor: String(ms[0].obs || '').replace(/^NF-e\s*/, ''), data: ms[0].data,
      total: num(itens.reduce((a, x) => a + x.qtd * x.custo, 0)), itens, estornada: false });
  }
  for (const chave of db.notas) if (!db.notasLista.some(n => n.chave === chave))
    db.notasLista.push({ id: uid(), chave, fornecedor: '', data: null, total: 0, itens: [], estornada: false, legado: true });
  db.notas = []; db.migrado = true; return true;
}
const save = async () => ref ? ref.set(db) : fs.writeFileSync(ARQ, JSON.stringify(db, null, 2));

// ---------- senha ----------
const SEG = E.SESSION_SECRET || crypto.createHash('sha256').update('nf:' + E.APP_SENHA).digest('hex');
const assina = v => crypto.createHmac('sha256', SEG).update(v).digest('base64url');
const hash = s => crypto.createHash('sha256').update(s).digest();
const emitir = () => { const exp = Date.now() + 30 * 864e5; return exp + '.' + assina(String(exp)); };
function logado(req) {
  const m = (req.headers.cookie || '').match(/(?:^|; )nf=([^;]+)/);
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const a = Buffer.from(sig), b = Buffer.from(assina(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const tentativas = {};
const pagina = erro => `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NotaFlow</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(700px 360px at 85% -10%,rgba(143,211,255,.18),transparent 60%),#07080b;font:15px system-ui,sans-serif;color:#f2f7fb}
form{background:#0f1217;border:1px solid #1f2630;border-top:3px solid #8fd3ff;padding:30px;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.55);width:min(340px,92vw)}
h1{margin:0 0 4px;font-size:24px}p{margin:0 0 18px;color:#8c9aa8}h1 span{color:#8fd3ff}
input{width:100%;padding:11px;border:1px solid #1f2630;background:#07080b;color:#f2f7fb;border-radius:9px;font:inherit;margin-bottom:12px}
button{width:100%;padding:11px;border:0;border-radius:9px;background:#8fd3ff;color:#06080c;font:inherit;font-weight:700;cursor:pointer}
.e{background:#2d1216;color:#ff7a85;padding:9px 12px;border-radius:9px;margin-bottom:12px;font-weight:600}</style></head>
<body><form method="post" action="/login"><h1>Nota<span>Flow</span></h1><p>Digite a senha para entrar.</p>${erro ? `<div class="e">${erro}</div>` : ''}
<input type="password" name="senha" placeholder="Senha" autofocus required><button>Entrar</button></form></body></html>`;

// ---------- regras do estoque ----------
const uid = () => crypto.randomBytes(6).toString('hex');
const num = v => Math.round((Number(v) || 0) * 1000) / 1000;
const norm = s => String(s || '').trim().toLowerCase();
const un = u => ['KG', 'L'].includes(String(u).toUpperCase()) ? String(u).toUpperCase() : 'UN';
const falha = m => { const e = new Error(m); e.http = 400; return e; };

function movimentar(i, tipo, qtd, extra = {}) {
  const { forcar, ...ex } = extra, q = num(qtd);
  if (tipo === 'saida' && q > i.saldo && !forcar) throw falha(`Saldo insuficiente de ${i.nome} (${i.saldo} ${i.unidade}).`);
  const dif = tipo === 'saida' ? -q : tipo === 'ajuste' ? q - i.saldo : q;
  i.saldo = num(i.saldo + dif);
  db.movs.unshift({ id: uid(), data: new Date().toISOString(), insumoId: i.id, nome: i.nome, unidade: i.unidade, tipo, qtd: num(dif), custo: i.custo, ...ex });
  if (db.movs.length > 3000) db.movs.length = 3000;
}

async function salvarInsumo(b, id) {
  if (!norm(b.nome)) throw falha('Informe o nome do insumo.');
  const campos = { nome: String(b.nome).trim(), unidade: un(b.unidade), categoria: String(b.categoria || 'Geral').trim() || 'Geral',
                   custo: num(b.custo), preco: num(b.preco), minimo: num(b.minimo), codigo: String(b.codigo || '').trim(), ean: String(b.ean || '').trim() };
  let i = id && db.insumos.find(x => x.id === id);
  if (id && !i) throw falha('Insumo não encontrado.');
  if (i) Object.assign(i, campos);
  else {
    i = { id: uid(), saldo: 0, ...campos }; db.insumos.push(i);
    if (num(b.saldo) > 0) movimentar(i, 'entrada', b.saldo, { obs: 'Saldo inicial' });
  }
  await save(); return i;
}

const eanOk = v => /^\d{8,14}$/.test(String(v || '').trim());
const achar = it => (eanOk(it.ean) && db.insumos.find(x => x.ean === String(it.ean).trim()))
  || (it.codigo && db.insumos.find(x => x.codigo === String(it.codigo))) || db.insumos.find(x => norm(x.nome) === norm(it.nome));

async function entradaNota({ chave, fornecedor, itens }) {
  if (chave && db.notasLista.some(n => n.chave === chave && !n.estornada)) throw falha('Esta nota já foi lançada.');
  if (!itens || !itens.length) throw falha('Nenhum item para lançar.');
  for (const it of itens) if (!(Number(it.qtd) > 0)) throw falha(`Quantidade inválida em "${it.nome}".`);
  const id = uid(), res = [], reg = [];
  for (const it of itens) {
    let i = achar(it);
    const novo = !i, q = num(it.qtd), c = num(it.custo);
    if (novo) { i = { id: uid(), saldo: 0, minimo: 0, nome: it.nome, unidade: un(it.unidade), categoria: it.categoria || 'Geral', custo: 0, preco: 0, codigo: String(it.codigo || ''), ean: '' }; db.insumos.push(i); }
    const custoAnt = i.custo, base = Math.max(i.saldo, 0);
    i.custo = (!custoAnt || base + q <= 0) ? c : num((base * custoAnt + q * c) / (base + q));   // custo médio ponderado
    if (!i.codigo && it.codigo) i.codigo = String(it.codigo);
    if (!i.ean && eanOk(it.ean)) i.ean = String(it.ean).trim();
    movimentar(i, 'entrada', q, { custo: c, custoAnt, nota: chave || '', obs: fornecedor ? 'NF-e ' + fornecedor : 'NF-e' });
    reg.push({ insumoId: i.id, nome: i.nome, unidade: i.unidade, qtd: q, custo: c, custoAnt });
    res.push({ nome: i.nome, acao: novo ? 'cadastrado' : 'saldo somado', saldo: i.saldo, unidade: i.unidade });
  }
  db.notasLista.unshift({ id, chave: chave || '', fornecedor: fornecedor || '', data: new Date().toISOString(),
    total: num(reg.reduce((a, x) => a + x.qtd * x.custo, 0)), itens: reg, estornada: false });
  await save(); return res;
}

async function estornarNota(id) {
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
    movimentar(i, 'saida', it.qtd, { custo: it.custo, estornoNota: n.id, obs: 'Estorno da nota ' + (n.fornecedor || n.chave.slice(-8)) });
  }
  n.estornada = true; n.estornadaEm = new Date().toISOString();
  await save(); return n;
}

async function saidas({ itens, obs }) {
  if (!itens || !itens.length) throw falha('Nenhum item na saída.');
  const lin = itens.map(it => {
    const i = db.insumos.find(x => x.id === it.insumoId); if (!i) throw falha('Insumo não encontrado.');
    const q = num(it.qtd); if (!(q > 0)) throw falha(`Quantidade inválida em ${i.nome}.`);
    return { i, q };
  });
  const tot = new Map(); for (const { i, q } of lin) tot.set(i, (tot.get(i) || 0) + q);
  for (const [i, q] of tot) if (q > i.saldo) throw falha(`Saldo insuficiente de ${i.nome} (${i.saldo} ${i.unidade}).`);
  for (const { i, q } of lin) movimentar(i, 'saida', q, { obs: String(obs || 'Saída rápida').slice(0, 120) });
  await save(); return { ok: true, itens: lin.length };
}

async function inventario({ itens }) {
  if (!itens || !itens.length) throw falha('Nenhum item contado.');
  const lin = itens.map(it => {
    const i = db.insumos.find(x => x.id === it.insumoId); if (!i) throw falha('Insumo não encontrado.');
    const c = Number(it.contado); if (!(c >= 0)) throw falha(`Contagem inválida em ${i.nome}.`);
    return { i, c: num(c) };
  });
  let ajustados = 0;
  for (const { i, c } of lin) if (c !== i.saldo) { movimentar(i, 'ajuste', c, { obs: 'Contagem de inventário' }); ajustados++; }
  await save(); return { contados: lin.length, ajustados };
}

// ---------- baixa automática pelas vendas da Cardápio Web ----------
// Item do pedido -> insumo: external_code do item = código (ou EAN) do insumo; sem código, mesmo nome.
// Opções/complementos só dão baixa se o external_code deles bater com o código de um insumo.
// Combos: baixa nos itens de dentro do combo. Pedido cancelado devolve o que foi baixado.
const BAIXA = ['confirmed', 'scheduled_confirmed', 'ready', 'released', 'waiting_to_catch', 'delivered', 'closed'];
let rodando = false;
const temAcesso = () => !!(db.cwToken || API_KEY);
async function trocarToken(params) {
  const r = await fetch(BASE + '/api/partner/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) { if (params.grant_type === 'refresh_token' && r.status < 500) db.cwToken = null; throw new Error('Token da Cardápio Web: ' + (j.error_description || j.error || j.message || r.status)); }
  db.cwToken = { access: j.access_token, refresh: j.refresh_token || (db.cwToken && db.cwToken.refresh), expira: Date.now() + ((Number(j.expires_in) || 7200) - 120) * 1000, scope: j.scope || '' };
  await save();
}
async function cw(path, retry = true) {
  if (db.cwToken && Date.now() > db.cwToken.expira && db.cwToken.refresh) await trocarToken({ grant_type: 'refresh_token', refresh_token: db.cwToken.refresh });
  const oauth = !!db.cwToken;
  const r = await fetch(API + path, { headers: oauth ? { Authorization: 'Bearer ' + db.cwToken.access } : { 'X-API-KEY': API_KEY } });
  if (r.status === 401 && oauth && retry && db.cwToken.refresh) { await trocarToken({ grant_type: 'refresh_token', refresh_token: db.cwToken.refresh }); return cw(path, false); }
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
function vincular(c) {
  if (c.codigo) { const i = db.insumos.find(x => (x.codigo && x.codigo === c.codigo) || (x.ean && x.ean === c.codigo)); if (i) return i; }
  return c.opcao ? null : db.insumos.find(x => norm(x.nome) === norm(c.nome)) || null;
}
function baixarPedido(p) {
  const por = {}, sem = [];
  for (const c of consumo(p)) {
    const i = vincular(c);
    if (!i) { if (!c.opcao) sem.push(c.nome); continue; }
    por[i.id] = (por[i.id] || 0) + c.qtd;
  }
  const baixas = [];
  for (const [id, q] of Object.entries(por)) {
    const i = db.insumos.find(x => x.id === id);
    if (q > 0) { movimentar(i, 'saida', q, { forcar: true, obs: `Venda Cardápio Web #${p.display_id || p.id}`, pedido: p.id }); baixas.push({ insumoId: id, qtd: num(q) }); }
  }
  db.vendas[p.id] = { display: p.display_id || p.id, status: p.status, data: new Date().toISOString(), baixas, semVinculo: [...new Set(sem)], estornado: false };
}
function estornarPedido(id) {
  const v = db.vendas[id];
  for (const b of v.baixas) { const i = db.insumos.find(x => x.id === b.insumoId); if (i) movimentar(i, 'entrada', b.qtd, { obs: `Cancelamento Cardápio Web #${v.display}`, pedido: id }); }
  v.estornado = true; v.status = 'canceled';
}
async function sincronizarVendas() {
  if (!temAcesso() || rodando) return db.vendasCfg;
  rodando = true;
  const cfg = db.vendasCfg, inicioCiclo = Date.now();
  try {
    if (!cfg.inicio) cfg.inicio = new Date().toISOString();   // só pedidos criados a partir daqui entram
    const desde = Math.max(Date.parse(cfg.ultimo || cfg.inicio) - 120e3, Date.now() - 23 * 3600e3);
    const lista = await cw('/orders?updated_since=' + encodeURIComponent(new Date(desde).toISOString()));
    const pedidos = Array.isArray(lista) ? lista : (lista.data || lista.orders || []);
    let baixados = 0, estornados = 0;
    for (const lite of pedidos) {
      const v = db.vendas[lite.id];
      if (v && !v.estornado && lite.status === 'canceled') { estornarPedido(lite.id); estornados++; await save(); continue; }
      if (v || !BAIXA.includes(lite.status) || Date.parse(lite.created_at) < Date.parse(cfg.inicio)) continue;
      baixarPedido(await cw('/orders/' + lite.id)); baixados++; await save();
    }
    cfg.ultimo = new Date(inicioCiclo).toISOString(); cfg.erro = null; cfg.ultimaExecucao = new Date().toISOString();
    cfg.ultimoResumo = { vistos: pedidos.length, baixados, estornados };
    const ids = Object.keys(db.vendas); if (ids.length > 1500) ids.slice(0, ids.length - 1500).forEach(k => delete db.vendas[k]);
    await save();
  } catch (e) { cfg.erro = e.message; cfg.ultimaExecucao = new Date().toISOString(); console.error('Vendas:', e.message); }
  finally { rodando = false; }
  return cfg;
}
const statusVendas = () => ({ ativo: temAcesso(), conectado: !!db.cwToken, modo: db.cwToken ? 'oauth' : API_KEY ? 'chave' : '', podeConectar: !!(CLIENT_ID && REDIRECT), ...db.vendasCfg,
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
 document.getElementById('info').innerHTML=!V.ativo?'<p class="mut">Ainda não conectado. '+(V.podeConectar?'Clique em Conectar à Cardápio Web (entre com a conta de Proprietário da loja).':'Defina CW_CLIENT_ID e CW_REDIRECT_URI para usar o app da CW App Store, ou CW_API_KEY para a chave antiga.')+'</p>':(V.erro?'<div class="msg">'+esc(V.erro)+'</div>':'')+(V.ultimaExecucao?'<p class="mut">Última consulta: '+dt(V.ultimaExecucao)+(V.ultimoResumo?' · '+V.ultimoResumo.baixados+' baixados, '+V.ultimoResumo.estornados+' devolvidos':'')+'</p>':'')+(V.inicio?'<p class="mut">Só entram pedidos criados depois de '+dt(V.inicio)+'.</p>':'');
 document.getElementById('rec').innerHTML=V.recentes.length?'<table><tr><th>Pedido</th><th>Data</th><th>Itens</th><th></th></tr>'+V.recentes.map(v=>'<tr><td>#'+esc(v.display)+'</td><td>'+dt(v.data)+'</td><td>'+v.itens+'</td><td>'+(v.estornado?'<span class="tag er">Cancelado</span>':'<span class="tag ok">Baixado</span>')+'</td></tr>').join('')+'</table>':'<p class="mut">Nenhuma venda baixada ainda.</p>';
 document.getElementById('semc').hidden=!V.semVinculo.length;document.getElementById('sem').textContent=V.semVinculo.join(', ');}
document.getElementById('b').onclick=async()=>{const b=document.getElementById('b');b.disabled=true;b.textContent='Consultando…';await fetch('/api/vendas/verificar',{method:'POST'});await ld();b.disabled=false;b.textContent='Verificar pedidos agora'};
ld();setInterval(ld,15000);
</script></body></html>`;

// ---------- servidor ----------
const corpo = req => new Promise(ok => { let b = ''; req.on('data', c => b += c); req.on('end', () => ok(b)); });
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const html = (res, code, s) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(s); };
// acrescenta o atalho "Vendas Cardápio Web" no menu lateral, sem precisar editar o index.html
const LINK_VENDAS = '<a href="/vendas"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h2l2.4 11h10.2L20 7H6M9 20h.01M17 20h.01"/></svg><span>Vendas Cardápio Web</span></a></nav>';

const pend = {}, b64 = b => Buffer.from(b).toString('base64url'), esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const servidor = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const https = req.headers['x-forwarded-proto'] === 'https';
  try {
    if (u.pathname === '/login') {
      if (req.method !== 'POST') return html(res, 200, pagina(''));
      const t = tentativas[ip] || { n: 0, ate: 0 };
      if (t.n >= 5 && Date.now() < t.ate) return html(res, 429, pagina('Muitas tentativas. Aguarde 10 minutos.'));
      const senha = new URLSearchParams(await corpo(req)).get('senha') || '';
      if (!crypto.timingSafeEqual(hash(senha), hash(E.APP_SENHA))) { tentativas[ip] = { n: t.n + 1, ate: Date.now() + 10 * 60e3 }; return html(res, 401, pagina('Senha incorreta.')); }
      delete tentativas[ip];
      res.writeHead(302, { Location: '/', 'Set-Cookie': `nf=${emitir()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${https ? '; Secure' : ''}` });
      return res.end();
    }
    if (u.pathname === '/sair') { res.writeHead(302, { Location: '/login', 'Set-Cookie': 'nf=; HttpOnly; Path=/; Max-Age=0' }); return res.end(); }
    if (!logado(req)) {
      if (u.pathname.startsWith('/api/')) return json(res, 401, { erro: 'Entre com a senha primeiro.' });
      res.writeHead(302, { Location: '/login' }); return res.end();
    }

    if (u.pathname === '/') return html(res, 200, fs.readFileSync('index.html', 'utf8').replace('</nav>', LINK_VENDAS));
    if (u.pathname === '/vendas') return html(res, 200, paginaVendas);
    if (u.pathname === '/oauth/login') {
      if (!CLIENT_ID || !REDIRECT) return html(res, 400, pagina('Defina CW_CLIENT_ID e CW_REDIRECT_URI no servidor.'));
      const verifier = b64(crypto.randomBytes(32)), state = b64(crypto.randomBytes(16));
      for (const k in pend) if (pend[k].ate < Date.now()) delete pend[k];
      pend[state] = { verifier, ate: Date.now() + 10 * 60e3 };
      const q = new URLSearchParams({ client_id: CLIENT_ID, state, redirect_uri: REDIRECT, code_challenge: b64(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' });
      res.writeHead(302, { Location: AUTH_URL + '?' + q }); return res.end();
    }
    if (u.pathname === '/oauth/callback') {
      const st = u.searchParams.get('state'), p = pend[st];
      if (u.searchParams.get('error')) return html(res, 400, pagina('A Cardápio Web não autorizou: ' + esc(u.searchParams.get('error')) + '. Entre com a conta de Proprietário e tente de novo.'));
      if (!p || p.ate < Date.now()) return html(res, 400, pagina('Link expirado. Volte em Vendas e clique em Conectar de novo.'));
      delete pend[st];
      await trocarToken({ grant_type: 'authorization_code', code: u.searchParams.get('code'), redirect_uri: REDIRECT, code_verifier: p.verifier });
      sincronizarVendas();
      res.writeHead(302, { Location: '/vendas' }); return res.end();
    }
    if (u.pathname === '/api/vendas') return json(res, 200, statusVendas());
    if (u.pathname === '/api/vendas/verificar' && req.method === 'POST') { if (!temAcesso()) throw falha('Conecte à Cardápio Web primeiro.'); await sincronizarVendas(); return json(res, 200, statusVendas()); }
    if (u.pathname === '/api/estado') return json(res, 200, { insumos: db.insumos, movs: db.movs, notas: db.notasLista });
    if (u.pathname === '/api/backup') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="notaflow-backup-${new Date().toISOString().slice(0, 10)}.json"` });
      return res.end(JSON.stringify({ insumos: db.insumos, movs: db.movs, notasLista: db.notasLista, vendas: db.vendas, vendasCfg: db.vendasCfg, migrado: true }, null, 2));
    }
    if (u.pathname === '/api/insumos' && req.method === 'POST') return json(res, 200, await salvarInsumo(JSON.parse(await corpo(req) || '{}')));
    const m = u.pathname.match(/^\/api\/insumos\/([a-f0-9]+)$/);
    if (m && req.method === 'PUT') return json(res, 200, await salvarInsumo(JSON.parse(await corpo(req) || '{}'), m[1]));
    if (m && req.method === 'DELETE') { db.insumos = db.insumos.filter(x => x.id !== m[1]); await save(); return json(res, 200, { ok: true }); }
    if (u.pathname === '/api/movimento' && req.method === 'POST') {
      const b = JSON.parse(await corpo(req) || '{}');
      const i = db.insumos.find(x => x.id === b.insumoId);
      if (!i) throw falha('Insumo não encontrado.');
      if (!['entrada', 'saida', 'ajuste'].includes(b.tipo)) throw falha('Tipo inválido.');
      if (!(Number(b.qtd) >= 0) || (b.tipo !== 'ajuste' && !(Number(b.qtd) > 0))) throw falha('Informe uma quantidade válida.');
      movimentar(i, b.tipo, b.qtd, { obs: String(b.obs || '').slice(0, 120) });
      await save(); return json(res, 200, i);
    }
    if (u.pathname === '/api/nota' && req.method === 'POST') return json(res, 200, await entradaNota(JSON.parse(await corpo(req) || '{}')));
    const mn = u.pathname.match(/^\/api\/notas\/([a-f0-9]+)\/estornar$/);
    if (mn && req.method === 'POST') return json(res, 200, await estornarNota(mn[1]));
    if (u.pathname === '/api/saidas' && req.method === 'POST') return json(res, 200, await saidas(JSON.parse(await corpo(req) || '{}')));
    if (u.pathname === '/api/inventario' && req.method === 'POST') return json(res, 200, await inventario(JSON.parse(await corpo(req) || '{}')));
    json(res, 404, { erro: 'não encontrado' });
  } catch (e) { json(res, e.http || 500, { erro: e.message }); }
});

carregar().then(() => servidor.listen(E.PORT || 3000, () => {
  console.log('NotaFlow na porta ' + (E.PORT || 3000));
  console.log(temAcesso() ? 'Baixa automática de vendas ligada (a cada ' + (E.CW_POLL_SEG || 30) + 's).' : 'Baixa de vendas aguardando conexão com a Cardápio Web (aba Vendas).');
  sincronizarVendas(); setInterval(sincronizarVendas, Math.max(10, Number(E.CW_POLL_SEG) || 30) * 1000);
})).catch(e => { console.error('Falha ao carregar os dados:', e.message); process.exit(1); });