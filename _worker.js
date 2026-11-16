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
    // ROUTE 2: OAuth Popup Initiation & Callback
    // ==========================================
    if (path.startsWith('/api/auth/')) {
      const parts = path.split('/');
      const platform = parts[3];
      const action = parts[4];

      if (action === 'callback') {
        const html = `<!DOCTYPE html>
        <html>
        <head><title>Authentication Success</title></head>
        <body style="background:#090d16;color:#fff;font-family:sans-serif;text-align:center;padding-top:60px;">
          <h2>Authorizing account...</h2>
          <script>
            const hash = window.location.hash.substring(1);
            const params = new URLSearchParams(hash || window.location.search);
            const accessToken = params.get('access_token') || params.get('code');
            if (accessToken && window.opener) {
              window.opener.postMessage({ type: 'OAUTH_SUCCESS', token: accessToken }, '*');
              window.close();
            } else if (accessToken) {
              document.body.innerHTML = "<h3>Token acquired! Token: " + accessToken + "</h3>";
            } else {
              document.body.innerHTML = "<h3>Authorization failed or token missing.</h3>";
            }
          </script>
        </body>
        </html>`;
        return new Response(html, { headers: { 'Content-Type': 'text/html' } });
      }

      const redirectUri = `${url.origin}/api/auth/${platform}/callback`;
      if (platform === 'instagram' || platform === 'facebook') {
        const clientId = env.META_CLIENT_ID || '1234567890';
        const scope = 'instagram_basic,instagram_content_publish,pages_show_list';
        const authUrl = `https://www.facebook.com/v21.0/dialog/oauth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&response_type=token`;
        return Response.redirect(authUrl, 302);
      }

      if (platform === 'youtube') {
        const clientId = env.GOOGLE_CLIENT_ID || '1234567890.apps.googleusercontent.com';
        const scope = 'https://www.googleapis.com/auth/youtube.upload';
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}&response_type=token`;
        return Response.redirect(authUrl, 302);
      }
    }

    // ==========================================
    // ROUTE 3: AI Caption & Multi-Image/Video Studio
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
    // ROUTE 4: Posts CRUD API (Enforces Linked Accounts)
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

          if (selectedPlatforms.includes('youtube') && (!body.media_url || !isVideoUrl(body.media_url))) {
            return Response.json({ error: 'YouTube requires a video (.mp4 / .mov) to be selected before scheduling.' }, { status: 400, headers: corsHeaders });
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
    // ROUTE 5: Manual Trigger to Test Auto-Publish
    // ==========================================
    if (path === '/api/publish-due' && request.method === 'POST') {
      const summary = await processScheduledPosts(env);
      return Response.json({ success: true, ...summary }, { headers: corsHeaders });
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

function isVideoUrl(url) {
  if (!url) return false;
  return /\.(mp4|mov|webm|m4v)(\?.*)?$/i.test(url) || url.startsWith('data:video/');
}

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
      const platformKey = plat.toLowerCase();
      const account = accountMap[platformKey];

      if (!account) {
        errors.push(`Post ${post.id}: Skipped ${plat} (account unlinked).`);
        postFailed = true;
        continue;
      }

      if (platformKey === 'instagram') {
        if (!post.media_url || !post.media_url.startsWith('http')) {
          errors.push(`Post ${post.id}: Instagram API requires a public HTTPS image or video URL.`);
          postFailed = true;
          continue;
        }

        try {
          const isVid = isVideoUrl(post.media_url);
          const containerPayload = isVid
            ? {
                media_type: 'REELS',
                video_url: post.media_url,
                caption: post.content,
                share_to_feed: true,
                access_token: account.access_token
              }
            : {
                image_url: post.media_url,
                caption: post.content,
                access_token: account.access_token
              };

          const containerRes = await fetch(
            `https://graph.facebook.com/v21.0/${account.account_id}/media`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(containerPayload)
            }
          );
          const containerData = await containerRes.json();
          if (!containerData.id) {
            throw new Error(containerData.error?.message || 'Failed to create IG media container');
          }

          if (isVid) {
            for (let attempt = 0; attempt < 6; attempt++) {
              await new Promise(r => setTimeout(r, 4000));
              const statusRes = await fetch(
                `https://graph.facebook.com/v21.0/${containerData.id}?fields=status_code&access_token=${account.access_token}`
              );
              const statusData = await statusRes.json();
              if (statusData.status_code === 'FINISHED') break;
              if (statusData.status_code === 'ERROR') {
                throw new Error('Instagram video transcoding failed.');
              }
            }
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
          errors.push(`Post ${post.id} (Instagram): ${err.message}`);
          postFailed = true;
        }
      }

      if (platformKey === 'youtube') {
        if (!post.media_url || !post.media_url.startsWith('http')) {
          errors.push(`Post ${post.id}: YouTube upload requires a public HTTPS video (.mp4) URL.`);
          postFailed = true;
          continue;
        }

        try {
          const videoFileRes = await fetch(post.media_url);
          if (!videoFileRes.ok) {
            throw new Error('Could not download source video file for YouTube upload.');
          }
          const videoBlob = await videoFileRes.blob();

          const lines = post.content.split('\n').filter(Boolean);
          const videoTitle = (lines[0] || 'New Video').slice(0, 95);

          const initRes = await fetch(
            'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${account.access_token}`,
                'Content-Type': 'application/json; charset=UTF-8',
                'X-Upload-Content-Type': videoBlob.type || 'video/mp4',
                'X-Upload-Content-Length': String(videoBlob.size)
              },
              body: JSON.stringify({
                snippet: {
                  title: videoTitle,
                  description: post.content,
                  categoryId: '22'
                },
                status: {
                  privacyStatus: 'public'
                }
              })
            }
          );

          const uploadLocation = initRes.headers.get('Location');
          if (!initRes.ok || !uploadLocation) {
            const errBody = await initRes.text();
            throw new Error(`YouTube init failed: ${errBody}`);
          }

          const uploadRes = await fetch(uploadLocation, {
            method: 'PUT',
            headers: {
              'Content-Type': videoBlob.type || 'video/mp4',
              'Content-Length': String(videoBlob.size)
            },
            body: videoBlob
          });

          if (!uploadRes.ok) {
            const upErr = await uploadRes.text();
            throw new Error(`YouTube binary upload failed: ${upErr}`);
          }
        } catch (err) {
          errors.push(`Post ${post.id} (YouTube): ${err.message}`);
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
