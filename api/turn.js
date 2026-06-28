// VersetLive — génération d'identifiants TURN Cloudflare éphémères.
//
// La coop (host ↔ copilotes) utilise WebRTC en pair-à-pair. Entre deux réseaux
// différents (NAT stricts, wifi d'entreprise, 4G), une connexion directe est
// souvent impossible : il faut un serveur TURN qui relaie le trafic. Les TURN
// publics gratuits de PeerJS sont peu fiables → on passe par Cloudflare TURN.
//
// Cette route renvoie des identifiants TURN à courte durée de vie générés à la
// demande. Les secrets restent côté serveur (variables d'environnement Vercel) ;
// le navigateur ne reçoit qu'un username/credential temporaire.
//
// Variables d'environnement requises (Vercel → Settings → Environment Variables) :
//   CLOUDFLARE_TURN_TOKEN_ID    — l'ID du TURN token (dashboard Cloudflare > Calls > TURN)
//   CLOUDFLARE_TURN_API_TOKEN   — la clé API associée à ce TURN token

const TTL_SECONDS = 86400; // 24 h — couvre largement un culte

export default async function handler(req, res) {
  const id = process.env.CLOUDFLARE_TURN_TOKEN_ID;
  const token = process.env.CLOUDFLARE_TURN_API_TOKEN;

  if (!id || !token) {
    res.status(500).json({ error: 'TURN non configuré (variables d\'environnement manquantes)' });
    return;
  }

  try {
    const r = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${id}/credentials/generate`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: TTL_SECONDS }),
      }
    );

    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      res.status(502).json({ error: 'cloudflare-error', status: r.status, detail });
      return;
    }

    const data = await r.json(); // { iceServers: { urls, username, credential } }
    // Pas de cache : chaque appel doit fournir des identifiants frais.
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: 'fetch-failed', detail: String(e && e.message || e) });
  }
}
