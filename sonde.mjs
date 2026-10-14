// Sonde extérieure des sites du Groupe L'Espadon.
//
// Demandée par le propriétaire le 2026-10-14. Elle tourne sur une machine de
// GitHub, hors du serveur, toutes les cinq minutes environ (GitHub retarde
// parfois ses tâches programmées de quelques minutes). C'est la seule qui
// puisse prévenir quand le serveur tombe en entier : une machine éteinte
// n'envoie plus de mail.
//
// Elle vérifie que chaque page s'affiche vraiment (statut et un mot attendu),
// la date d'expiration des certificats HTTPS et des noms de domaine, et que la
// sonde du serveur donne des nouvelles (son « battement », la date de son
// dernier passage, lisible à une adresse publique).
//
// Un mail quand un problème apparaît, un quand il est réglé, un rappel par
// jour tant qu'il dure. L'état vit dans etat.json, enregistré par le
// workflow : c'est aussi ce qui garde le dépôt actif, GitHub coupant les
// tâches programmées d'un dépôt public sans activité depuis 60 jours.
//
// Aucun secret ici : la clé d'envoi est un secret du dépôt (RESEND_API_KEY).

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import tls from 'node:tls'

const CONFIG = JSON.parse(readFileSync(new URL('./sites.json', import.meta.url), 'utf8'))
const FICHIER_ETAT = new URL('./etat.json', import.meta.url)
const etat = existsSync(FICHIER_ETAT) ? JSON.parse(readFileSync(FICHIER_ETAT, 'utf8')) : {}

const ESSAIS = 3 // une page n'est déclarée en panne qu'après trois échecs
const ENTRE_ESSAIS_MS = 15_000 // espacés de 15 s : un hoquet du réseau ne réveille personne
const LENT_SECONDES = 8
const CERTIFICAT_JOURS = 14
const DOMAINE_JOURS = 30
const RAPPEL_HEURES = 24
const DESTINATAIRES = (process.env.MAIL_TO || 'groupe.lespadon@yahoo.fr').split(',').map((s) => s.trim()).filter(Boolean)
const EXPEDITEUR = process.env.MAIL_FROM || "Surveillance Groupe L'Espadon <surveillance@spa-groupelespadon.com>"
const QUE_FAIRE =
  "Ouvrez Claude Code dans VS Code et dites : « j'ai reçu une alerte des sites, regarde et corrige ». " +
  'Vous recevrez un mail « RÉTABLI » dès que la sonde verra le problème réglé.'

const maintenant = new Date()
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const paris = (d) =>
  new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    .format(new Date(d))
    .replace(' ', ' à ')
    .replace(':', ' h ')
const jours = (d) => Math.floor((new Date(d) - maintenant) / 86_400_000)
function duree(ms) {
  const min = Math.max(1, Math.round(ms / 60_000))
  if (min < 60) return `${min} min`
  if (min < 1440) return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`
  const j = Math.floor(min / 1440)
  return `${j} jour${j > 1 ? 's' : ''}`
}
const echapper = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const constats = []
const constat = (cle, titre, detail, { gravite = 'alerte', confirmations = 1 } = {}) =>
  constats.push({ cle, titre, detail, gravite, confirmations })

// --- Pages ---------------------------------------------------------------------

async function essayer(p) {
  const debut = performance.now()
  try {
    const r = await fetch(p.url, {
      redirect: p.suivre === false ? 'manual' : 'follow',
      signal: AbortSignal.timeout(20_000),
      headers: { 'user-agent': 'sonde-lespadon (GitHub Actions)', 'cache-control': 'no-cache' },
    })
    const corps = await r.text()
    const secondes = (performance.now() - debut) / 1000
    if (!(p.statuts ?? [200]).includes(r.status)) return { ok: false, secondes, raison: `HTTP ${r.status}` }
    if (p.texte && !corps.includes(p.texte)) return { ok: false, secondes, raison: `la page ne contient plus « ${p.texte} »` }
    return { ok: true, secondes }
  } catch (e) {
    const raison = e.name === 'TimeoutError' ? 'aucune réponse en 20 s' : String(e.cause?.code || e.cause?.message || e.message)
    return { ok: false, secondes: (performance.now() - debut) / 1000, raison }
  }
}

async function verifierPage(p) {
  let dernier
  for (let i = 0; i < ESSAIS; i++) {
    if (i) await pause(ENTRE_ESSAIS_MS)
    dernier = await essayer(p)
    if (dernier.ok) break
  }
  const hote = new URL(p.url).host
  if (!dernier.ok) {
    constat(`page:${p.url}`, `${p.nom} ne répond plus (${hote})`, `${p.url} : ${dernier.raison}, ${ESSAIS} essais en ${(ESSAIS - 1) * 15} s`)
  } else if (dernier.secondes > LENT_SECONDES) {
    constat(`lent:${p.url}`, `${p.nom} est très lent`, `${p.url} : ${dernier.secondes.toFixed(1)} s (seuil ${LENT_SECONDES} s)`, {
      gravite: 'attention',
      confirmations: 2,
    })
  }
  return { url: p.url, ...dernier }
}

// --- Battement de la sonde du serveur ---------------------------------------

async function verifierBattement() {
  const { url, minutes } = CONFIG.battement
  let raison
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { 'cache-control': 'no-cache' } })
    const date = new Date((await r.text()).trim())
    if (!r.ok) raison = `HTTP ${r.status}`
    else if (Number.isNaN(date.getTime())) raison = 'date illisible'
    else if (maintenant - date > minutes * 60_000) raison = `dernier passage le ${paris(date)}, il y a ${duree(maintenant - date)}`
  } catch (e) {
    raison = String(e.cause?.code || e.message)
  }
  if (raison)
    constat(
      'battement',
      'La sonde du serveur ne donne plus de nouvelles',
      `${url} : ${raison}. Le serveur ne surveille plus rien lui-même (sonde arrêtée, ou serveur en panne).`,
      { confirmations: 2 },
    )
}

// --- Certificats HTTPS -------------------------------------------------------

function finDeCertificat(hote) {
  return new Promise((resolve) => {
    const s = tls.connect({ host: hote, port: 443, servername: hote, timeout: 15_000 }, () => {
      const c = s.getPeerCertificate()
      s.end()
      resolve(c?.valid_to ? new Date(c.valid_to) : null)
    })
    s.on('error', () => resolve(null))
    s.on('timeout', () => {
      s.destroy()
      resolve(null)
    })
  })
}

async function verifierCertificats() {
  for (const hote of CONFIG.certificats) {
    const fin = await finDeCertificat(hote)
    if (fin && jours(fin) < CERTIFICAT_JOURS)
      constat(`certificat:${hote}`, `Le certificat HTTPS de ${hote} expire dans ${jours(fin)} jours`, `fin le ${paris(fin)} ; le site s'affichera « non sécurisé » ce jour-là`)
  }
}

// --- Noms de domaine (une fois par jour) ----------------------------------------

// Les registres eux-mêmes : rdap.org, qui les aiguille, refuse les programmes
// (403). Le registre suisse ne publie aucune date de fin : le .ch n'est pas
// contrôlé sur ce point.
const REGISTRES = { com: 'https://rdap.verisign.com/com/v1/domain/', fr: 'https://rdap.nic.fr/domain/' }

async function verifierDomaines() {
  const aujourdhui = maintenant.toISOString().slice(0, 10)
  if (etat.domainesLe !== aujourdhui) {
    etat.domaines ??= {}
    for (const d of CONFIG.domaines) {
      const registre = REGISTRES[d.split('.').pop()]
      if (!registre) continue
      try {
        const r = await fetch(registre + d, { signal: AbortSignal.timeout(20_000), headers: { accept: 'application/rdap+json' } })
        if (!r.ok) continue
        const fin = (await r.json()).events?.find((e) => e.eventAction === 'expiration')?.eventDate
        if (fin) etat.domaines[d] = fin
      } catch {
        // Un registre muet aujourd'hui garde la date lue la veille.
      }
    }
    etat.domainesLe = aujourdhui
  }
  for (const [d, fin] of Object.entries(etat.domaines ?? {})) {
    if (jours(fin) < DOMAINE_JOURS)
      constat(`domaine:${d}`, `Le nom de domaine ${d} expire dans ${jours(fin)} jours`, `fin le ${paris(fin)} ; à renouveler chez le registraire (OVH)`)
  }
}

// --- E-mail ------------------------------------------------------------------

const STYLE = { alerte: ['#fde2e1', '#8a1c13'], attention: ['#fff4d6', '#7a4b00'], retabli: ['#e7f6ec', '#14532d'] }

function blocHtml(titre, elements, style) {
  if (!elements.length) return ''
  const [fond, encre] = STYLE[style]
  return (
    `<h2 style="font-size:15px;margin:20px 0 4px;color:#222">${echapper(titre)}</h2>` +
    elements
      .map(
        (e) =>
          `<div style="background:${fond};color:${encre};border-radius:8px;padding:12px 14px;margin:8px 0">` +
          `<div style="font-size:16px;font-weight:600">${echapper(e.titre)}</div>` +
          `<div style="font-size:13px;margin-top:4px">${echapper(e.quand)}</div>` +
          (e.detail ? `<div style="font-size:12px;color:#555;margin-top:8px;font-family:Consolas,monospace">${echapper(e.detail)}</div>` : '') +
          '</div>',
      )
      .join('')
  )
}

const blocTexte = (titre, elements) =>
  elements.length ? `\n${titre.toUpperCase()}\n` + elements.map((e) => `- ${e.titre} (${e.quand})\n    ${e.detail}\n`).join('') : ''

async function avertir(nouveaux, rappels, retablis) {
  if (!nouveaux.length && !rappels.length && !retablis.length) return true
  const graves = nouveaux.filter((e) => e.gravite === 'alerte')
  let objet = graves.length
    ? `ALERTE SITE : ${graves[0].titre}`
    : nouveaux.length
      ? `À REGARDER : ${nouveaux[0].titre}`
      : rappels.length
        ? `TOUJOURS EN PANNE : ${rappels[0].titre}`
        : `RÉTABLI : ${retablis[0].titre}`
  const total = nouveaux.length + rappels.length + retablis.length
  if (total > 1) objet += ` (et ${total - 1} autre${total > 2 ? 's' : ''})`
  const intro = 'La sonde extérieure, qui regarde vos sites depuis Internet comme un client, a vu quelque chose.'
  const pied = nouveaux.length || rappels.length ? QUE_FAIRE : "Rien à faire : c'est réglé."
  const attentions = nouveaux.filter((e) => e.gravite !== 'alerte')
  const texte =
    intro +
    '\n' +
    blocTexte('Problème', graves) +
    blocTexte('À regarder', attentions) +
    blocTexte('Toujours en cours', rappels) +
    blocTexte('Réglé', retablis) +
    `\n${pied}\n`
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:640px;margin:auto;color:#222;font-size:15px;line-height:1.45">` +
    `<p style="font-size:16px">${echapper(intro)}</p>` +
    blocHtml('Problème', graves, 'alerte') +
    blocHtml('À regarder', attentions, 'attention') +
    blocHtml('Toujours en cours', rappels, 'alerte') +
    blocHtml('Réglé', retablis, 'retabli') +
    `<p style="margin-top:24px;font-size:14px">${echapper(pied)}</p>` +
    `<p style="font-size:12px;color:#777">Contrôle fait depuis GitHub le ${paris(maintenant)}.</p></div>`

  if (!process.env.RESEND_API_KEY) {
    console.error('E-mail non envoyé : secret RESEND_API_KEY absent.')
    return false
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: EXPEDITEUR, to: DESTINATAIRES, subject: objet, text: texte, html }),
  }).catch((e) => ({ ok: false, status: String(e.message), text: async () => '' }))
  if (!r.ok) {
    console.error(`E-mail refusé (${r.status}) : ${(await r.text()).slice(0, 300)}`)
    return false
  }
  console.log(`E-mail envoyé : ${objet}`)
  return true
}

// --- Passage -----------------------------------------------------------------

// Lancé à la main avec « essai » coché : un mail d'exemple, rien d'autre. Seul
// moyen de prouver que la clé d'envoi marche sans attendre une vraie panne.
if (process.env.ESSAI === 'true') {
  const exemple = {
    titre: 'ESSAI, rien n’est en panne : Le site des spas (accueil) ne répond plus (spa-groupelespadon.com)',
    quand: `depuis le ${paris(maintenant)}`,
    detail: 'https://spa-groupelespadon.com/ : HTTP 502 (exemple)',
    gravite: 'alerte',
  }
  process.exit((await avertir([exemple], [], [])) ? 0 : 1)
}

const resultats = await Promise.all(CONFIG.pages.map(verifierPage))
await Promise.all([verifierBattement(), verifierCertificats(), verifierDomaines()])

for (const r of resultats) console.log(`${r.ok ? 'bon ' : 'EN PANNE'} ${r.secondes.toFixed(2)} s  ${r.url}${r.raison ? `  (${r.raison})` : ''}`)
for (const c of constats) console.log(`[${c.gravite}] ${c.titre} : ${c.detail}`)

const avant = etat.problemes ?? {}
const problemes = {}
const nouveaux = []
const rappels = []
const retablis = []
for (const c of constats) {
  const p = { depuis: maintenant.toISOString(), vu: 0, signale: false, ...avant[c.cle], titre: c.titre, detail: c.detail, gravite: c.gravite }
  p.vu += 1
  const quand = `depuis le ${paris(p.depuis)}`
  if (!p.signale && p.vu >= c.confirmations) {
    nouveaux.push({ ...p, cle: c.cle, quand })
    p.signale = true
    p.rappel = maintenant.toISOString()
  } else if (p.signale && maintenant - new Date(p.rappel) > RAPPEL_HEURES * 3_600_000) {
    rappels.push({ ...p, quand: `${quand}, soit ${duree(maintenant - new Date(p.depuis))}` })
    p.rappel = maintenant.toISOString()
  }
  problemes[c.cle] = p
}
for (const [cle, p] of Object.entries(avant)) {
  if (!problemes[cle] && p.signale) retablis.push({ ...p, quand: `réglé après ${duree(maintenant - new Date(p.depuis))}` })
}

const envoye = await avertir(nouveaux, rappels, retablis)
if (!envoye) for (const e of nouveaux) problemes[e.cle].signale = false

// La semaine en cours : une écriture au moins chaque semaine, qui garde le
// dépôt actif aux yeux de GitHub même quand tout va bien.
const jeudi = new Date(Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth(), maintenant.getUTCDate() + 3 - ((maintenant.getUTCDay() + 6) % 7)))
const semaine = `${jeudi.getUTCFullYear()}-S${String(Math.ceil(((jeudi - Date.UTC(jeudi.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7)).padStart(2, '0')}`

writeFileSync(FICHIER_ETAT, JSON.stringify({ ...etat, semaine, problemes }, null, 1) + '\n')

// Un mail qui ne part pas fait échouer la tâche : GitHub prévient alors le
// propriétaire du dépôt par son propre canal, en secours.
if (!envoye) process.exit(1)
