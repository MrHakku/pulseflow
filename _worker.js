export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // ==========================================
    // ROUTE 1: Linked Social Accounts API (D1)
    // GET /api/accounts | POST /api/accounts | DELETE /api/accounts/:platform
    // ==========================================
    if (path.startsWith('/api/accounts')) {
      try {
        // List connected accounts (never return raw access_token to frontend)
        if ((path === '/api/accounts' || path === '/api/accounts/') && request.method === 'GET') {
          const { results } = await env.DB.prepare(
            'SELECT platform, account_name, account_id, connected_at FROM accounts ORDER BY connected_at DESC'
          ).all();
          return Response.json(results || [], { headers: corsHeaders });
        }

        // Link or update a social account
        if ((path === '/api/accounts' || path === '/api/accounts/') && request.method === 'POST') {
          const { platform, account_name, account_id, access_token } = await request.json();

          if (!platform || !account_name || !account_id || !access_token) {
            return Response.json(
              { error: 'Platform, Account Handle/Name, Account ID, and Access Token are all required.' },
              { status: 400, headers: corsHeaders }
            );
          }

          await env.DB.prepare(
            `INSERT INTO accounts (platform, account_name, account_id, access_token, connected_at)
             VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(platform) DO UPDATE SET
               account_name = excluded.account_name,
               account_id = excluded.account_id,
               access_token = excluded.access_token,
               connected_at = CURRENT_TIMESTAMP`
          )
            .bind(platform.toLowerCase(), account_name.trim(), account_id.trim(), access_token.trim())
            .run();

          return Response.json({ success: true }, { headers: corsHeaders });
        }

        // Disconnect a linked account
        if (request.method === 'DELETE') {
          const platform = path.split('/').pop().toLowerCase();
          await env.DB.prepare('DELETE FROM accounts WHERE platform = ?').bind(platform).run();
          return Response.json({ success: true }, { headers: corsHeaders });
        }
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
      }
    }

    // ==========================================
    // ROUTE 2: AI Caption & Image Generator
    // POST /api/ai
    // ==========================================
    if (path === '/api/ai' && request.method === 'POST') {
      try {
        if (!env.AI) {
          return Response.json(
            { error: 'Workers AI binding (AI) is not configured in wrangler.toml' },
            { status: 500, headers: corsHeaders }
          );
        }

        const { prompt, generateImage = false, platforms = ['instagram'] } = await request.json();

        if (!prompt || !prompt.trim()) {
          return Response.json(
            { error: 'Please enter a topic or prompt first.' },
            { status: 400, headers: corsHeaders }
          );
        }

        const systemPrompt = `You are an expert social media copywriter. Write one engaging, ready-to-publish post caption with relevant hashtags tailored for ${platforms.join(', ')}. Keep it concise, authentic, and high-converting. Do not wrap the response in quotes or add introductory filler.`;

        const textResult = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt }
          ]
        });

        const caption = textResult.response?.trim() || '';
        let imageDataUrl = null;

        if (generateImage) {
          const imagePrompt = `Clean, modern, high-resolution promotional social media graphic, professional photography and lighting, no messy text: ${prompt}`;
          const imageStream = await env.AI.run('@cf/bytedance/stable-diffusion-xl-lightning', {
            prompt: imagePrompt
          });

          const arrayBuffer = await new Response(imageStream).arrayBuffer();
          const bytes = new Uint8Array(arrayBuffer);
          let binary = '';
          for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          imageDataUrl = `data:image/png;base64,${btoa(binary)}`;
        }

        return Response.json(
          { success: true, caption, media_url: imageDataUrl },
          { headers: corsHeaders }
        );
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
      }
    }

    // ==========================================
    // ROUTE 3: Posts CRUD API (Enforces Linked Accounts)
    // GET/POST /api/posts | DELETE /api/posts/:id
    // ==========================================
    if (path.startsWith('/api/posts')) {
      try {
        if ((path === '/api/posts' || path === '/api/posts/') && request.method === 'GET') {
          const { results } = await env.DB.prepare(
            'SELECT * FROM posts ORDER BY scheduled_date DESC'
          ).all();
          return Response.json(results || [], { headers: corsHeaders });
        }

        if ((path === '/api/posts' || path === '/api/posts/') && request.method === 'POST') {
          const body = await request.json();
          const selectedPlatforms = (body.platforms || []).map(p => p.toLowerCase());

          if (selectedPlatforms.length === 0) {
            return Response.json(
              { error: 'Please select at least one linked social platform.' },
              { status: 400, headers: corsHeaders }
            );
          }

          // Verify every selected platform is linked in D1 before allowing save/queue
          const { results: linkedAccounts } = await env.DB.prepare(
            'SELECT platform FROM accounts'
          ).all();
          const linkedSet = new Set((linkedAccounts || []).map(a => a.platform.toLowerCase()));
          const unlinked = selectedPlatforms.filter(p => !linkedSet.has(p));

          if (unlinked.length > 0) {
            return Response.json(
              {
                error: `Account not linked for: ${unlinked.join(', ')}. Please link your account(s) first before scheduling.`
              },
              { status: 403, headers: corsHeaders }
            );
          }

          const id = 'post_' + Date.now();
          await env.DB.prepare(
            'INSERT INTO posts (id, brand_id, content, platforms, status, scheduled_date, media_url) VALUES (?, ?, ?, ?, ?, ?, ?)'
          )
            .bind(
              id,
              body.brand_id || 1,
              body.content,
              JSON.stringify(selectedPlatforms),
              body.status || 'queue',
              body.scheduled_date || new Date().toISOString(),
              body.media_url || ''
            )
            .run();

          return Response.json({ success: true, id }, { headers: corsHeaders });
        }

        if (request.method === 'DELETE') {
          const id = path.split('/').pop();
          await env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(id).run();
          return Response.json({ success: true }, { headers: corsHeaders });
        }
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
      }
    }

    // ==========================================
    // ROUTE 4: Manual Trigger to Process Due Queue
    // POST /api/publish-due
    // ==========================================
    if (path === '/api/publish-due' && request.method === 'POST') {
      const summary = await processScheduledPosts(env);
      return Response.json({ success: true, ...summary }, { headers: corsHeaders });
    }

    // ==========================================
    // ROUTE 5: Serve Static Frontend (public/)
    // ==========================================
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(processScheduledPosts(env));
  }
};

// ==========================================
// Helper: Auto-Publish Due Posts Using Linked D1 Accounts
// ==========================================
async function processScheduledPosts(env) {
  const nowIso = new Date().toISOString();

  const { results: duePosts } = await env.DB.prepare(
    "SELECT * FROM posts WHERE status = 'queue' AND scheduled_date <= ?"
  )
    .bind(nowIso)
    .all();

  const { results: allAccounts } = await env.DB.prepare('SELECT * FROM accounts').all();
  const accountMap = {};
  for (const acc of allAccounts || []) {
    accountMap[acc.platform.toLowerCase()] = acc;
  }

  let publishedCount = 0;
  const errors = [];

  for (const post of duePosts || []) {
    let platforms = [];
    try {
      platforms = JSON.parse(post.platforms);
    } catch {
      platforms = [post.platforms];
    }

    let postFailed = false;

    for (const plat of platforms) {
      const account = accountMap[plat.toLowerCase()];
      if (!account) {
        errors.push(`Post ${post.id}: Skipped ${plat} (account unlinked).`);
        postFailed = true;
        continue;
      }

      if (plat.toLowerCase() === 'instagram') {
        if (!post.media_url || !post.media_url.startsWith('http')) {
          errors.push(`Post ${post.id}: Instagram Graph API requires a public HTTPS image URL.`);
          postFailed = true;
          continue;
        }

        try {
          const containerRes = await fetch(
            `https://graph.facebook.com/v21.0/${account.account_id}/media`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                image_url: post.media_url,
                caption: post.content,
                access_token: account.access_token
              })
            }
          );
          const containerData = await containerRes.json();
          if (!containerData.id) {
            throw new Error(containerData.error?.message || 'Failed to create IG media container');
          }

          const publishRes = await fetch(
            `https://graph.facebook.com/v21.0/${account.account_id}/media_publish`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                creation_id: containerData.id,
                access_token: account.access_token
              })
            }
          );
          const publishData = await publishRes.json();
          if (!publishData.id) {
            throw new Error(publishData.error?.message || 'Failed to publish IG media');
          }
        } catch (err) {
          errors.push(`Post ${post.id} (${plat}): ${err.message}`);
          postFailed = true;
        }
      }
    }

    if (!postFailed) {
      await env.DB.prepare("UPDATE posts SET status = 'sent' WHERE id = ?")
        .bind(post.id)
        .run();
      publishedCount++;
    }
  }

  return { checked: (duePosts || []).length, published: publishedCount, errors };
}
