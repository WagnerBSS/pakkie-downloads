// Vercel Serverless Function — estatísticas públicas do canal Pakkie.
// Configure YOUTUBE_API_KEY nas Environment Variables da Vercel.

const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3';
const CHANNEL_HANDLE = process.env.YOUTUBE_CHANNEL_HANDLE || '@Pakkie_';

async function youtubeGet(resource, params, apiKey) {
  const url = new URL(`${YOUTUBE_API}/${resource}`);
  for (const [key, value] of Object.entries({ ...params, key: apiKey })) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url.toString());
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `YouTube API respondeu HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: 'A API do YouTube ainda não foi configurada. Adicione YOUTUBE_API_KEY nas variáveis de ambiente da Vercel.'
    });
  }

  try {
    const channelData = await youtubeGet('channels', {
      part: 'snippet,statistics,contentDetails',
      forHandle: CHANNEL_HANDLE,
      maxResults: 1
    }, apiKey);

    const channel = channelData.items?.[0];
    if (!channel) {
      return res.status(404).json({ error: `Não encontrei o canal ${CHANNEL_HANDLE}. Confira YOUTUBE_CHANNEL_HANDLE.` });
    }

    // Busca até os 200 vídeos mais recentes do canal e monta o ranking por views.
    // O limite mantém a consulta rápida e o consumo de cota baixo.
    const uploadPlaylistId = channel.contentDetails?.relatedPlaylists?.uploads;
    let pageToken = undefined;
    const videoIds = [];

    for (let page = 0; page < 4; page++) {
      const playlistData = await youtubeGet('playlistItems', {
        part: 'contentDetails',
        playlistId: uploadPlaylistId,
        maxResults: 50,
        pageToken
      }, apiKey);

      for (const item of playlistData.items || []) {
        const id = item.contentDetails?.videoId;
        if (id) videoIds.push(id);
      }

      pageToken = playlistData.nextPageToken;
      if (!pageToken || videoIds.length >= 200) break;
    }

    const videoBatches = [];
    for (let i = 0; i < videoIds.length; i += 50) {
      videoBatches.push(videoIds.slice(i, i + 50));
    }

    const videoResponses = await Promise.all(videoBatches.map(ids =>
      youtubeGet('videos', {
        part: 'snippet,statistics',
        id: ids.join(',')
      }, apiKey)
    ));

    const videos = videoResponses
      .flatMap(result => result.items || [])
      .map(video => ({
        id: video.id,
        title: video.snippet?.title || 'Vídeo sem título',
        thumbnail: video.snippet?.thumbnails?.high?.url || video.snippet?.thumbnails?.medium?.url || `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`,
        views: Number(video.statistics?.viewCount || 0),
        publishedAt: video.snippet?.publishedAt || null,
        url: `https://www.youtube.com/watch?v=${video.id}`
      }))
      .sort((a, b) => b.views - a.views)
      .slice(0, 8);

    return res.status(200).json({
      channel: {
        title: channel.snippet?.title || 'Pakkie',
        url: `https://www.youtube.com/${CHANNEL_HANDLE}`,
        views: Number(channel.statistics?.viewCount || 0),
        subscriberCount: channel.statistics?.hiddenSubscriberCount
          ? null
          : channel.statistics?.subscriberCount == null
            ? null
            : Number(channel.statistics.subscriberCount),
        hiddenSubscriberCount: Boolean(channel.statistics?.hiddenSubscriberCount)
      },
      videos,
      rankingScope: 'Entre os 200 vídeos mais recentes do canal',
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Erro ao consultar YouTube Data API:', error);
    return res.status(error.status === 403 ? 502 : 500).json({
      error: error.status === 403
        ? 'A API do YouTube recusou a consulta. Confira se YouTube Data API v3 está ativada e se a chave está correta.'
        : 'Não foi possível carregar os dados do YouTube agora.'
    });
  }
};
