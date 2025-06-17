const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const { RateLimiterMemory } = require('rate-limiter-flexible');

const app = express();
const PORT = process.env.PORT || 8890;

// 安全中间件
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'", "https://www.googleapis.com"],
        },
    },
}));

// 压缩响应
app.use(compression());

// 日志中间件
app.use(morgan('combined'));

// 速率限制
const rateLimiter = new RateLimiterMemory({
    keyGenerator: (req) => req.ip,
    points: 100, // 100 requests
    duration: 60, // per 60 seconds
});

const rateLimitMiddleware = async (req, res, next) => {
    try {
        await rateLimiter.consume(req.ip);
        next();
    } catch (rejRes) {
        res.status(429).json({
            error: '请求过于频繁，请稍后再试',
            retryAfter: Math.round(rejRes.msBeforeNext / 1000) || 1,
        });
    }
};

// 中间件配置
app.use(rateLimitMiddleware);
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// 存储API密钥的内存缓存
const apiKeyCache = new Map();

// YouTube API 基础URL
const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

// 路由：获取主页
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 路由：健康检查
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        version: '1.0.0',
        environment: process.env.NODE_ENV || 'development'
    });
});

// 路由：获取系统信息
app.get('/api/info', (req, res) => {
    res.json({
        name: 'YouTube数据提取工具',
        version: '1.0.0',
        description: '搜索YouTube视频并提取频道信息，生成Excel报表',
        author: 'Assistant',
        endpoints: [
            'GET /api/health - 健康检查',
            'GET /api/info - 系统信息',
            'POST /api/validate-key - 验证API密钥',
            'POST /api/search - 搜索YouTube数据',
            'POST /api/generate-excel - 生成Excel报表'
        ]
    });
});

// 路由：验证API密钥
app.post('/api/validate-key', async (req, res) => {
    try {
        const { apiKey } = req.body;
        
        if (!apiKey) {
            return res.status(400).json({ error: 'API密钥不能为空' });
        }

        // 测试API密钥
        const testUrl = `${YOUTUBE_API_BASE}/search?part=snippet&q=test&maxResults=1&key=${apiKey}`;
        const response = await axios.get(testUrl);
        
        if (response.status === 200) {
            res.json({ valid: true, message: 'API密钥验证成功' });
        } else {
            res.json({ valid: false, message: 'API密钥无效' });
        }
    } catch (error) {
        console.error('API密钥验证失败:', error.message);
        res.json({ valid: false, message: error.response?.data?.error?.message || 'API密钥验证失败' });
    }
});

// 路由：搜索YouTube视频
app.post('/api/search', async (req, res) => {
    try {
        const { apiKey, keyword, maxResults = 50, order = 'relevance', publishedAfter } = req.body;
        
        if (!apiKey || !keyword) {
            return res.status(400).json({ error: '缺少必要参数' });
        }

        console.log(`开始搜索: ${keyword}, 最大结果: ${maxResults}`);

        // 构建搜索URL
        let searchUrl = `${YOUTUBE_API_BASE}/search?part=snippet&q=${encodeURIComponent(keyword)}&type=video&maxResults=${maxResults}&order=${order}&key=${apiKey}`;
        
        if (publishedAfter) {
            searchUrl += `&publishedAfter=${publishedAfter}`;
        }

        // 执行搜索
        const searchResponse = await axios.get(searchUrl);
        const videos = searchResponse.data.items || [];

        if (videos.length === 0) {
            return res.json({ videos: [], channels: [] });
        }

        // 提取唯一的频道ID
        const channelIds = [...new Set(videos.map(video => video.snippet.channelId))];
        console.log(`找到 ${videos.length} 个视频，${channelIds.length} 个独特频道`);

        // 批量获取频道详细信息
        const channelsData = await getChannelsInBatches(apiKey, channelIds);

        // 为每个频道尝试获取额外信息
        const enrichedChannels = await Promise.all(
            channelsData.map(channel => enrichChannelData(channel))
        );

        res.json({
            videos: videos.map(video => ({
                videoId: video.id.videoId,
                title: video.snippet.title,
                channelId: video.snippet.channelId,
                channelTitle: video.snippet.channelTitle,
                publishedAt: video.snippet.publishedAt,
                description: video.snippet.description,
                thumbnails: video.snippet.thumbnails
            })),
            channels: enrichedChannels
        });

    } catch (error) {
        console.error('搜索失败:', error.message);
        res.status(500).json({ 
            error: error.response?.data?.error?.message || '搜索失败',
            details: error.message 
        });
    }
});

// 批量获取频道信息
async function getChannelsInBatches(apiKey, channelIds) {
    const batchSize = 50; // YouTube API限制
    const allChannels = [];

    for (let i = 0; i < channelIds.length; i += batchSize) {
        const batch = channelIds.slice(i, i + batchSize);
        
        try {
            const channelsUrl = `${YOUTUBE_API_BASE}/channels?part=snippet,statistics,brandingSettings,contentDetails&id=${batch.join(',')}&key=${apiKey}`;
            const response = await axios.get(channelsUrl);
            
            if (response.data.items) {
                allChannels.push(...response.data.items);
            }
            
            console.log(`获取频道信息进度: ${Math.min(i + batchSize, channelIds.length)}/${channelIds.length}`);
            
            // 避免API限制，添加延迟
            if (i + batchSize < channelIds.length) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        } catch (error) {
            console.error(`获取频道批次失败 (${i}-${i + batchSize}):`, error.message);
        }
    }

    return allChannels;
}

// 丰富频道数据
async function enrichChannelData(channel) {
    const snippet = channel.snippet;
    const statistics = channel.statistics;
    const branding = channel.brandingSettings;

    // 基础频道信息
    const channelData = {
        channelId: channel.id,
        channelName: snippet.title,
        channelUrl: `https://www.youtube.com/channel/${channel.id}`,
        customUrl: snippet.customUrl ? `https://www.youtube.com/${snippet.customUrl}` : '',
        description: snippet.description || '',
        country: snippet.country || '未知',
        subscriberCount: statistics.subscriberCount || '未公开',
        videoCount: statistics.videoCount || '0',
        viewCount: statistics.viewCount || '0',
        createdAt: snippet.publishedAt,
        thumbnails: snippet.thumbnails,
        defaultLanguage: snippet.defaultLanguage || '',
        keywords: branding?.channel?.keywords || '',
        email: '',
        socialLinks: [],
        websiteUrl: ''
    };

    // 尝试从频道描述中提取联系信息
    try {
        const contactInfo = extractContactInfo(snippet.description);
        channelData.email = contactInfo.email;
        channelData.socialLinks = contactInfo.socialLinks;
        channelData.websiteUrl = contactInfo.websiteUrl;
    } catch (error) {
        console.error('提取联系信息失败:', error.message);
    }

    // 尝试从频道页面获取更多信息
    try {
        const additionalInfo = await scrapeChannelPage(channel.id);
        if (additionalInfo.email && !channelData.email) {
            channelData.email = additionalInfo.email;
        }
        if (additionalInfo.socialLinks && additionalInfo.socialLinks.length > 0) {
            channelData.socialLinks = [...new Set([...channelData.socialLinks, ...additionalInfo.socialLinks])];
        }
    } catch (error) {
        console.error('抓取频道页面失败:', error.message);
    }

    return channelData;
}

// 从文本中提取联系信息
function extractContactInfo(text) {
    const result = {
        email: '',
        socialLinks: [],
        websiteUrl: ''
    };

    if (!text) return result;

    // 提取邮箱
    const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
    const emails = text.match(emailRegex);
    if (emails && emails.length > 0) {
        result.email = emails[0];
    }

    // 提取社交媒体链接
    const socialPatterns = [
        /(?:https?:\/\/)?(?:www\.)?instagram\.com\/[a-zA-Z0-9._-]+/gi,
        /(?:https?:\/\/)?(?:www\.)?twitter\.com\/[a-zA-Z0-9._-]+/gi,
        /(?:https?:\/\/)?(?:www\.)?facebook\.com\/[a-zA-Z0-9._-]+/gi,
        /(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@[a-zA-Z0-9._-]+/gi,
        /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9._-]+/gi
    ];

    socialPatterns.forEach(pattern => {
        const matches = text.match(pattern);
        if (matches) {
            result.socialLinks.push(...matches);
        }
    });

    // 提取网站链接
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const urls = text.match(urlRegex);
    if (urls && urls.length > 0) {
        // 过滤掉社交媒体链接，保留网站链接
        const websiteUrls = urls.filter(url => 
            !url.includes('instagram.com') && 
            !url.includes('twitter.com') && 
            !url.includes('facebook.com') && 
            !url.includes('tiktok.com') && 
            !url.includes('linkedin.com') &&
            !url.includes('youtube.com')
        );
        if (websiteUrls.length > 0) {
            result.websiteUrl = websiteUrls[0];
        }
    }

    return result;
}

// 抓取频道页面获取额外信息
async function scrapeChannelPage(channelId) {
    const result = {
        email: '',
        socialLinks: []
    };

    try {
        // 访问频道的"关于"页面
        const aboutUrl = `https://www.youtube.com/channel/${channelId}/about`;
        const response = await axios.get(aboutUrl, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        const $ = cheerio.load(response.data);
        
        // 尝试从页面中提取联系信息
        const pageText = $('body').text();
        const contactInfo = extractContactInfo(pageText);
        
        result.email = contactInfo.email;
        result.socialLinks = contactInfo.socialLinks;

        // 延迟以避免被阻止
        await new Promise(resolve => setTimeout(resolve, 1000));

    } catch (error) {
        console.error(`抓取频道页面失败 ${channelId}:`, error.message);
    }

    return result;
}

// 路由：生成Excel报表
app.post('/api/generate-excel', (req, res) => {
    try {
        const { channels, keyword } = req.body;
        
        if (!channels || channels.length === 0) {
            return res.status(400).json({ error: '没有数据可以导出' });
        }

        // 准备Excel数据
        const wsData = [
            [
                '频道名称', '频道ID', '频道链接', '自定义链接', '订阅者数', 
                '视频数量', '总观看次数', '国家', '创建时间', '邮箱', 
                '社交媒体链接', '网站链接', '描述', '关键词', '默认语言'
            ]
        ];

        channels.forEach(channel => {
            wsData.push([
                channel.channelName,
                channel.channelId,
                channel.channelUrl,
                channel.customUrl,
                channel.subscriberCount,
                channel.videoCount,
                channel.viewCount,
                channel.country,
                formatDate(channel.createdAt),
                channel.email,
                channel.socialLinks.join('; '),
                channel.websiteUrl,
                channel.description.substring(0, 500), // 限制描述长度
                channel.keywords,
                channel.defaultLanguage
            ]);
        });

        // 创建工作簿
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.aoa_to_sheet(wsData);

        // 设置列宽
        ws['!cols'] = [
            {wch: 25}, // 频道名称
            {wch: 25}, // 频道ID
            {wch: 50}, // 频道链接
            {wch: 30}, // 自定义链接
            {wch: 15}, // 订阅者数
            {wch: 12}, // 视频数量
            {wch: 15}, // 总观看次数
            {wch: 10}, // 国家
            {wch: 12}, // 创建时间
            {wch: 30}, // 邮箱
            {wch: 50}, // 社交媒体链接
            {wch: 40}, // 网站链接
            {wch: 60}, // 描述
            {wch: 30}, // 关键词
            {wch: 10}  // 默认语言
        ];

        XLSX.utils.book_append_sheet(wb, ws, 'YouTube频道数据');

        // 生成文件
        const filename = `YouTube频道数据_${keyword}_${new Date().toISOString().split('T')[0]}.xlsx`;
        const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);

    } catch (error) {
        console.error('生成Excel失败:', error.message);
        res.status(500).json({ error: '生成Excel失败', details: error.message });
    }
});

// 工具函数：格式化日期
function formatDate(dateString) {
    return new Date(dateString).toLocaleDateString('zh-CN');
}

// 错误处理中间件
app.use((error, req, res, next) => {
    console.error('服务器错误:', error);
    res.status(500).json({ error: '服务器内部错误' });
});

// 启动服务器
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 YouTube数据提取服务器已启动`);
    console.log(`📡 服务地址: http://localhost:${PORT}`);
    console.log(`🌐 局域网地址: http://0.0.0.0:${PORT}`);
    console.log(`⚙️  端口: ${PORT}`);
    console.log('=====================================');
});

// 优雅关闭
process.on('SIGINT', () => {
    console.log('\n正在关闭服务器...');
    process.exit(0);
});

module.exports = app;
