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
    // ROUTE 1: Linked Accounts API (D1)
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
            return Response.json(
              { error: 'Platform, Account Name, ID, and Access Token are required.' },
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
    // ROUTE 2: AI Caption & Multi-Image/Video Studio
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
    // ROUTE 3: Posts CRUD API
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
    // ROUTE 4: Developer Sandbox Simulation Endpoint
    // ==========================================
    if (path === '/api/sandbox/simulate' && request.method === 'POST') {
      const summary = await processScheduledPosts(env, true); // true = force simulate for developer testing
      return Response.json({ success: true, ...summary }, { headers: corsHeaders });
    }

    // ==========================================
    // ROUTE 5: Serve Static Frontend (public/)
    // ==========================================
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(processScheduledPosts(env, false));
  }
};

async function processScheduledPosts(env, forceSimulate = false) {
  const nowIso = new Date().toISOString();
  let query = "SELECT * FROM posts WHERE status = 'queue'";
  let params = [];

  if (!forceSimulate) {
    query += " AND scheduled_date <= ?";
    params.push(nowIso);
  }

  const { results: duePosts } = await env.DB.prepare(query).bind(...params).all();

  let publishedCount = 0;
  const errors = [];

  for (const post of duePosts || []) {
    // In developer simulation mode, we instantly mark queued posts as 'sent' successfully
    await env.DB.prepare("UPDATE posts SET status = 'sent' WHERE id = ?")
      .bind(post.id)
      .run();
    publishedCount++;
  }

  return { checked: (duePosts || []).length, published: publishedCount, errors };
}