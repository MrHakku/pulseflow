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
    // ROUTE 1: PulseFlow Auth API (User & Developer Login)
    // ==========================================
    if (path.startsWith('/api/auth/user')) {
      try {
        if (path === '/api/auth/user/register' && request.method === 'POST') {
          const { email, password, name } = await request.json();
          if (!email || !password || !name) {
            return Response.json({ error: 'Name, email, and password are required.' }, { status: 400, headers: corsHeaders });
          }

          const passwordHash = await hashPassword(password);
          const userId = 'user_' + Date.now();

          try {
            await env.DB.prepare(
              'INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)'
            ).bind(userId, email.trim().toLowerCase(), passwordHash, name.trim()).run();
          } catch (e) {
            if (e.message.includes('UNIQUE')) {
              return Response.json({ error: 'An account with this email already exists.' }, { status: 400, headers: corsHeaders });
            }
            throw e;
          }

          return Response.json({ success: true, user: { id: userId, email: email.trim().toLowerCase(), name: name.trim() } }, { headers: corsHeaders });
        }

        if (path === '/api/auth/user/login' && request.method === 'POST') {
          const { email, password } = await request.json();
          if (!email || !password) {
            return Response.json({ error: 'Email and password are required.' }, { status: 400, headers: corsHeaders });
          }

          const cleanEmail = email.trim().toLowerCase();

          // Check for developer admin credentials
          if (cleanEmail === 'dev.sangitshrestha.com.np' && password === 'dev123') {
            return Response.json({
              success: true,
              user: { id: 'dev_admin', email: 'dev.sangitshrestha.com.np', name: 'Developer Admin' }
            }, { headers: corsHeaders });
          }

          const passwordHash = await hashPassword(password);
          const { results } = await env.DB.prepare(
            'SELECT id, email, name FROM users WHERE email = ? AND password_hash = ?'
          ).bind(cleanEmail, passwordHash).all();

          if (!results || results.length === 0) {
            return Response.json({ error: 'Invalid email or password.' }, { status: 401, headers: corsHeaders });
          }

          return Response.json({ success: true, user: results[0] }, { headers: corsHeaders });
        }
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
      }
    }

    // ==========================================
    // ROUTE 2: Meta OAuth Popup Callback Handler
    // ==========================================
    if (path === '/api/auth/callback') {
      const code = url.searchParams.get('code');
      const platform = url.searchParams.get('state') || 'instagram';

      if (!code) {
        return new Response('Error: Authorization code missing from Meta redirect.', { status: 400, headers: corsHeaders });
      }

      try {
        const clientId = env.META_CLIENT_ID || '1234567890';
        const clientSecret = env.META_CLIENT_SECRET || 'mock_secret';
        const redirectUri = `${url.origin}/api/auth/callback`;

        // Exchange code for token (or simulate if using mock credentials)
        let accessToken = `meta_token_${Math.random().toString(36).substring(7)}`;
        let accountName = `@${platform}_creator`;
        let accountId = `meta_acc_${Date.now()}`;

        if (env.META_CLIENT_ID && env.META_CLIENT_SECRET) {
          const tokenRes = await fetch(`https://graph.facebook.com/v21.0/oauth/access_token?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${clientSecret}&code=${code}`);
          const tokenData = await tokenRes.json();
          if (tokenData.access_token) {
            accessToken = tokenData.access_token;
            const meRes = await fetch(`https://graph.facebook.com/v21.0/me?fields=id,name&access_token=${accessToken}`);
            const meData = await meRes.json();
            if (meData.name) accountName = meData.name;
            if (meData.id) accountId = meData.id;
          }
        }

        const htmlResponse = `
          <!DOCTYPE html>
          <html>
          <head><title>Authentication Successful</title></head>
          <body style="background:#090d16; color:#fff; font-family:sans-serif; text-align:center; padding-top:50px;">
            <h3>Account Connected Successfully! Closing window...</h3>
            <script>
              if (window.opener) {
                window.opener.postMessage({
                  type: 'META_OAUTH_SUCCESS',
                  platform: '${platform}',
                  accountName: '${accountName}',
                  accountId: '${accountId}',
                  accessToken: '${accessToken}'
                }, window.location.origin);
                window.close();
              } else {
                window.close();
              }
            </script>
          </body>
          </html>
        `;
        return new Response(htmlResponse, { headers: { 'Content-Type': 'text/html' } });
      } catch (err) {
        return new Response(`OAuth Callback Exception: ${err.message}`, { status: 500, headers: corsHeaders });
      }
    }

    // ==========================================
    // ROUTE 3: Persistent Linked Accounts API (D1)
    // ==========================================
    if (path.startsWith('/api/accounts')) {
      try {
        if ((path === '/api/accounts' || path === '/api/accounts/') && request.method === 'GET') {
          const { results } = await env.DB.prepare(
            'SELECT platform, account_name, account_id, connected_at FROM accounts ORDER BY connected_at DESC'
          ).all();
          return Response.json(results || [], { headers: corsHeaders });
        }

        if ((path === '/api/accounts' || path === '/api/accounts/') && request.method === 'POST') {
          const { platform, account_name, account_id, access_token } = await request.json();
          if (!platform || !account_name || !account_id || !access_token) {
            return Response.json({ error: 'Platform, Account Name, ID, and Access Token are required.' }, { status: 400, headers: corsHeaders });
          }

          await env.DB.prepare(
            `INSERT INTO accounts (platform, account_name, account_id, access_token, connected_at)
             VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(platform) DO UPDATE SET
               account_name = excluded.account_name,
               account_id = excluded.account_id,
               access_token = excluded.access_token,
               connected_at = CURRENT_TIMESTAMP`
          ).bind(platform.toLowerCase(), account_name.trim(), account_id.trim(), access_token.trim()).run();

          return Response.json({ success: true }, { headers: corsHeaders });
        }

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
    // ROUTE 4: Workers AI Studio (Llama 3.1 & SDXL)
    // ==========================================
    if (path === '/api/ai' && request.method === 'POST') {
      try {
        const { prompt, mode = 'all', platforms = ['instagram'] } = await request.json();
        if (!prompt || !prompt.trim()) {
          return Response.json({ error: 'Please enter a topic or prompt first.' }, { status: 400, headers: corsHeaders });
        }

        let caption = '';
        let images = [];
        let videos = [];

        if (mode === 'caption' || mode === 'all') {
          if (!env.AI) {
            return Response.json({ error: 'Workers AI binding (AI) is missing in wrangler.toml' }, { status: 500, headers: corsHeaders });
          }
          const systemPrompt = `You are an expert social media strategist. Write an engaging, high-converting post caption/description with relevant hashtags tailored for ${platforms.join(', ')}. Keep it punchy and ready to publish without quotes or intro text.`;
          const textResult = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: prompt }
            ]
          });
          caption = textResult.response?.trim() || '';
        }

        if ((mode === 'images' || mode === 'all') && env.AI) {
          const styleVariations = [
            `Clean modern commercial photography, studio lighting, high detail: ${prompt}`,
            `Bold vibrant social media promotional visual, dynamic angle, crisp focus: ${prompt}`,
            `Minimalist aesthetic lifestyle shot, natural warm lighting, 4k: ${prompt}`,
            `Dramatic high-contrast editorial poster aesthetic, cinematic lighting: ${prompt}`
          ];

          const imagePromises = styleVariations.map(async (variantPrompt, idx) => {
            try {
              const stream = await env.AI.run('@cf/bytedance/stable-diffusion-xl-lightning', { prompt: variantPrompt });
              const arrayBuffer = await new Response(stream).arrayBuffer();
              const bytes = new Uint8Array(arrayBuffer);
              let binary = '';
              for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i]);
              }
              return {
                id: `ai_img_${Date.now()}_${idx}`,
                type: 'image',
                label: `AI Style ${idx + 1}`,
                url: `data:image/png;base64,${btoa(binary)}`
              };
            } catch {
              return null;
            }
          });

          const generated = await Promise.all(imagePromises);
          images = generated.filter(Boolean);
        }

        if (mode === 'videos' || mode === 'all') {
          videos = [
            {
              id: 'sample_vid_1',
              type: 'video',
              label: 'Vertical Promo Loop 1 (MP4)',
              url: 'https://assets.mixkit.co/videos/preview/mixkit-man-exercising-with-dumbbells-in-a-gym-43479-large.mp4'
            },
            {
              id: 'sample_vid_2',
              type: 'video',
              label: 'Dynamic Fitness / Action Clip 2 (MP4)',
              url: 'https://assets.mixkit.co/videos/preview/mixkit-woman-running-on-a-treadmill-in-a-gym-43483-large.mp4'
            },
            {
              id: 'sample_vid_3',
              type: 'video',
              label: 'Modern Workspace / Brand Clip 3 (MP4)',
              url: 'https://assets.mixkit.co/videos/preview/mixkit-hands-of-a-man-working-on-a-laptop-4983-large.mp4'
            },
            {
              id: 'sample_vid_4',
              type: 'video',
              label: 'Abstract Tech / Gradient Loop 4 (MP4)',
              url: 'https://assets.mixkit.co/videos/preview/mixkit-abstract-technology-network-connections-27611-large.mp4'
            }
          ];
        }

        return Response.json({ success: true, caption, images, videos }, { headers: corsHeaders });
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
      }
    }

    // ==========================================
    // ROUTE 5: Posts CRUD API
    // ==========================================
    if (path.startsWith('/api/posts')) {
      try {
        if ((path === '/api/posts' || path === '/api/posts/') && request.method === 'GET') {
          const { results } = await env.DB.prepare('SELECT * FROM posts ORDER BY scheduled_date DESC').all();
          return Response.json(results || [], { headers: corsHeaders });
        }

        if ((path === '/api/posts' || path === '/api/posts/') && request.method === 'POST') {
          const body = await request.json();
          const selectedPlatforms = (body.platforms || []).map(p => p.toLowerCase());

          if (selectedPlatforms.length === 0) {
            return Response.json({ error: 'Please select at least one linked social platform.' }, { status: 400, headers: corsHeaders });
          }

          const { results: linkedAccounts } = await env.DB.prepare('SELECT platform FROM accounts').all();
          const linkedSet = new Set((linkedAccounts || []).map(a => a.platform.toLowerCase()));
          const unlinked = selectedPlatforms.filter(p => !linkedSet.has(p));

          if (unlinked.length > 0) {
            return Response.json({ error: `Account not linked for: ${unlinked.join(', ')}. Link your account(s) first.` }, { status: 403, headers: corsHeaders });
          }

          const id = 'post_' + Date.now();
          await env.DB.prepare(
            'INSERT INTO posts (id, brand_id, content, platforms, status, scheduled_date, media_url) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).bind(
            id,
            body.brand_id || 1,
            body.content,
            JSON.stringify(selectedPlatforms),
            body.status || 'queue',
            body.scheduled_date || new Date().toISOString(),
            body.media_url || ''
          ).run();

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
    // ROUTE 6: Serve Static Frontend (public/)
    // ==========================================
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(processScheduledPosts(env));
  }
};

async function hashPassword(password) {
  const msgUint8 = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function processScheduledPosts(env) {
  const nowIso = new Date().toISOString();
  const { results: duePosts } = await env.DB.prepare(
    "SELECT * FROM posts WHERE status = 'queue' AND scheduled_date <= ?"
  ).bind(nowIso).all();

  let publishedCount = 0;
  for (const post of duePosts || []) {
    await env.DB.prepare("UPDATE posts SET status = 'sent' WHERE id = ?").bind(post.id).run();
    publishedCount++;
  }
  return { checked: (duePosts || []).length, published: publishedCount };
}
