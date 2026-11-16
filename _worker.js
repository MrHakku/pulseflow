export default {
  // 1. HTTP Request Handler (Frontend + API Routes)
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
    // ROUTE 1: AI Caption & Image Generator
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

        // Generate engaging social media caption with Llama 3.1
        const systemPrompt = `You are an expert social media copywriter. Write one engaging, ready-to-publish post caption with relevant hashtags tailored for ${platforms.join(', ')}. Keep it concise, authentic, and high-converting. Do not wrap the response in quotes or add introductory filler.`;

        const textResult = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt }
          ]
        });

        const caption = textResult.response?.trim() || '';
        let imageDataUrl = null;

        // Optionally generate a promo graphic using Stable Diffusion XL Lightning
        if (generateImage) {
          const imagePrompt = `Clean, modern, high-resolution promotional social media graphic, professional photography and lighting, no messy text: ${prompt}`;
          const imageStream = await env.AI.run('@cf/bytedance/stable-diffusion-xl-lightning', {
            prompt: imagePrompt
          });

          // Convert binary image stream to Base64 Data URL for instant preview & storage
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
    // ROUTE 2: Posts CRUD API (Cloudflare D1)
    // GET/POST /api/posts | DELETE /api/posts/:id
    // ==========================================
    if (path.startsWith('/api/posts')) {
      try {
        // Fetch all posts
        if ((path === '/api/posts' || path === '/api/posts/') && request.method === 'GET') {
          const { results } = await env.DB.prepare(
            'SELECT * FROM posts ORDER BY scheduled_date DESC'
          ).all();
          return Response.json(results, { headers: corsHeaders });
        }

        // Create new scheduled post or draft
        if ((path === '/api/posts' || path === '/api/posts/') && request.method === 'POST') {
          const body = await request.json();
          const id = 'post_' + Date.now();

          await env.DB.prepare(
            'INSERT INTO posts (id, brand_id, content, platforms, status, scheduled_date, media_url) VALUES (?, ?, ?, ?, ?, ?, ?)'
          )
            .bind(
              id,
              body.brand_id || 1,
              body.content,
              JSON.stringify(body.platforms || ['instagram']),
              body.status || 'queue',
              body.scheduled_date || new Date().toISOString(),
              body.media_url || ''
            )
            .run();

          return Response.json({ success: true, id }, { headers: corsHeaders });
        }

        // Delete a post by ID
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
    // ROUTE 3: Manual Trigger to Test Auto-Publish
    // POST /api/publish-due
    // ==========================================
    if (path === '/api/publish-due' && request.method === 'POST') {
      const summary = await processScheduledPosts(env);
      return Response.json({ success: true, ...summary }, { headers: corsHeaders });
    }

    // ==========================================
    // ROUTE 4: Serve Static Frontend (public/)
    // ==========================================
    return env.ASSETS.fetch(request);
  },

  // 2. Cron Trigger Handler (Runs automatically on schedule)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(processScheduledPosts(env));
  }
};

// ==========================================
// Helper: Auto-Publish Due Posts to Instagram
// ==========================================
async function processScheduledPosts(env) {
  const nowIso = new Date().toISOString();

  // Find all queued posts whose scheduled_date has passed
  const { results: duePosts } = await env.DB.prepare(
    "SELECT * FROM posts WHERE status = 'queue' AND scheduled_date <= ?"
  )
    .bind(nowIso)
    .all();

  let publishedCount = 0;
  const errors = [];

  for (const post of duePosts) {
    let platforms = [];
    try {
      platforms = JSON.parse(post.platforms);
    } catch {
      platforms = [post.platforms];
    }

    // Publish to Instagram if selected and credentials are configured
    if (platforms.includes('instagram')) {
      if (!env.IG_USER_ID || !env.IG_ACCESS_TOKEN) {
        errors.push(`Post ${post.id}: Missing IG_USER_ID or IG_ACCESS_TOKEN secrets.`);
        continue;
      }

      if (!post.media_url || !post.media_url.startsWith('http')) {
        errors.push(`Post ${post.id}: Instagram API requires a public HTTPS image URL.`);
        continue;
      }

      try {
        // Step 1: Create Instagram Media Container
