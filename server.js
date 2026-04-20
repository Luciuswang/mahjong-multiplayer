const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const compression = require('compression');
const fs = require('fs');

const app = express();

// 启用 gzip 压缩
app.use(compression());

const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    // 性能优化配置
    pingTimeout: 30000,        // 30秒无响应视为断开
    pingInterval: 10000,       // 10秒心跳间隔
    upgradeTimeout: 15000,     // 升级超时
    maxHttpBufferSize: 1e6,    // 限制消息大小 1MB
    perMessageDeflate: {       // 启用消息压缩
        threshold: 512,        // 超过512字节才压缩
        zlibDeflateOptions: {
            chunkSize: 16 * 1024
        },
        zlibInflateOptions: {
            windowBits: 15
        },
        clientNoContextTakeover: true,
        serverNoContextTakeover: true
    },
    transports: ['websocket', 'polling'],  // 优先使用 WebSocket
    allowUpgrades: true
});

// 禁用 HTML 文件缓存，确保客户端获取最新代码
app.use((req, res, next) => {
    if (req.path.endsWith('.html') || req.path === '/' || req.path.endsWith('/')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
    next();
});

// ==================== 访问统计 ====================
const STATS_FILE = path.join(__dirname, 'visit_stats.json');

function loadStats() {
    try {
        if (fs.existsSync(STATS_FILE)) {
            return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
        }
    } catch (e) { console.error('读取统计数据失败:', e.message); }
    return { total: 0, uniqueIPs: [], daily: {} };
}

function saveStats(stats) {
    try {
        const slim = { ...stats, uniqueIPs: stats.uniqueIPs.slice(-5000) };
        fs.writeFileSync(STATS_FILE, JSON.stringify(slim, null, 2));
    } catch (e) { console.error('保存统计数据失败:', e.message); }
}

let visitStats = loadStats();

function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.headers['x-real-ip'] ||
           req.connection?.remoteAddress || 'unknown';
}

app.use((req, res, next) => {
    if (req.path === '/' || req.path === '/index.html' || req.path === '/gomoku/' || req.path === '/gomoku/index.html') {
        const ip = getClientIP(req);
        const today = new Date().toISOString().slice(0, 10);
        const page = req.path.includes('gomoku') ? 'gomoku' : 'mahjong';

        visitStats.total++;
        if (!visitStats.daily[today]) visitStats.daily[today] = { pv: 0, ips: [], mahjong: 0, gomoku: 0 };
        visitStats.daily[today].pv++;
        visitStats.daily[today][page]++;
        if (!visitStats.daily[today].ips.includes(ip)) visitStats.daily[today].ips.push(ip);
        if (!visitStats.uniqueIPs.includes(ip)) visitStats.uniqueIPs.push(ip);

        // 只保留最近 90 天
        const keys = Object.keys(visitStats.daily).sort();
        if (keys.length > 90) {
            keys.slice(0, keys.length - 90).forEach(k => delete visitStats.daily[k]);
        }
    }
    next();
});

// 每 5 分钟保存一次统计
setInterval(() => saveStats(visitStats), 300000);
process.on('exit', () => saveStats(visitStats));
process.on('SIGINT', () => { saveStats(visitStats); process.exit(); });
process.on('SIGTERM', () => { saveStats(visitStats); process.exit(); });

// 统计数据 API
app.get('/api/stats', (req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const todayData = visitStats.daily[today] || { pv: 0, ips: [], mahjong: 0, gomoku: 0 };
    const last7 = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        const data = visitStats.daily[key] || { pv: 0, ips: [], mahjong: 0, gomoku: 0 };
        last7.push({ date: key, pv: data.pv, uv: data.ips.length, mahjong: data.mahjong, gomoku: data.gomoku });
    }
    res.json({
        total_pv: visitStats.total,
        total_uv: visitStats.uniqueIPs.length,
        today: { pv: todayData.pv, uv: todayData.ips.length, mahjong: todayData.mahjong, gomoku: todayData.gomoku },
        last7days: last7,
        online: { mahjong: io.engine?.clientsCount || 0, gomoku: (typeof gomokuIO !== 'undefined' ? gomokuIO.sockets?.size : 0) || 0 }
    });
});

// 访客检查 API（新手引导用，基于 IP 判断是否老用户）
app.get('/api/check-visitor', (req, res) => {
    const ip = getClientIP(req);
    const returning = (visitStats.onboardedIPs || []).includes(ip);
    res.json({ returning });
});
app.post('/api/mark-visited', express.json(), (req, res) => {
    const ip = getClientIP(req);
    if (!visitStats.onboardedIPs) visitStats.onboardedIPs = [];
    if (!visitStats.onboardedIPs.includes(ip)) {
        visitStats.onboardedIPs.push(ip);
        if (visitStats.onboardedIPs.length > 10000) {
            visitStats.onboardedIPs = visitStats.onboardedIPs.slice(-8000);
        }
    }
    res.json({ ok: true });
});

// 静态文件服务
app.use(express.static(path.join(__dirname)));

// 提供麻将牌图片
// 优先从本地 img 目录加载，如果不存在则从单人版目录加载
const localImgPath = path.join(__dirname, 'img');
const fallbackImgPath = path.join(__dirname, '../mahjong/img');

if (fs.existsSync(localImgPath)) {
    app.use('/img', express.static(localImgPath));
} else {
    app.use('/img', express.static(fallbackImgPath));
}

// 游戏常量（哈灵/上海敲麻：144 张）
const TILE_TYPES = ['wan', 'tiao', 'tong']; // 万、条、筒
const TILE_VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const WINDS = ['east', 'south', 'west', 'north']; // 东南西北（座位风）
const WIND_NAMES = { east: '东', south: '南', west: '西', north: '北' };
// 字牌（东南西北中发白）各 4 张
const HONOR_VALUES = ['dong', 'nan', 'xi', 'bei', 'zhong', 'fa', 'bai'];
const HONOR_NAMES = {
    dong: '东', nan: '南', xi: '西', bei: '北',
    zhong: '红中', fa: '发财', bai: '白板'
};
// 箭牌摸到视为花牌，亮出补牌（上海敲麻）
const JIAN_AS_FLOWER = new Set(['zhong', 'fa', 'bai']);
// 花牌（春夏秋冬梅兰竹菊各 1）
const FLOWERS = ['chun', 'xia', 'qiu', 'dong_hua', 'mei', 'lan', 'zhu', 'ju'];
const FLOWER_NAMES = {
    chun: '春', xia: '夏', qiu: '秋', dong_hua: '冬',
    mei: '梅', lan: '兰', zhu: '竹', ju: '菊'
};

// 房间管理
const gameRooms = new Map();
const playerSockets = new Map();

function normalizeVoice(voice) {
    if (voice === 'female02') return 'female01';
    if (voice === 'male02') return 'male';
    return voice === 'male' ? 'male' : 'female01';
}

// ==================== 用户和好友系统 ====================
const users = new Map();           // oderId -> userInfo
const friendCodes = new Map();     // friendCode -> oderId
const onlineUsers = new Map();     // oderId -> socketId

// 数据持久化文件路径
const DATA_FILE = path.join(__dirname, 'user_data.json');

// 加载用户数据
function loadUserData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            
            // 恢复users Map
            if (data.users) {
                data.users.forEach(user => {
                    users.set(user.oderId, user);
                    friendCodes.set(user.friendCode, user.oderId);
                });
            }
            
            console.log(`已加载 ${users.size} 个用户数据`);
        }
    } catch (err) {
        console.error('加载用户数据失败:', err);
    }
}

// 保存用户数据
function saveUserData() {
    try {
        const data = {
            users: Array.from(users.values()),
            savedAt: Date.now()
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        console.log(`已保存 ${users.size} 个用户数据`);
    } catch (err) {
        console.error('保存用户数据失败:', err);
    }
}

// 启动时加载数据
loadUserData();

// 定期保存数据（每5分钟）
setInterval(saveUserData, 5 * 60 * 1000);

// 进程退出时保存数据
process.on('SIGINT', () => {
    console.log('正在保存数据...');
    saveUserData();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('正在保存数据...');
    saveUserData();
    process.exit(0);
});

// 生成6位好友码
function generateFriendCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
        code = '';
        for (let i = 0; i < 6; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
    } while (friendCodes.has(code));
    return code;
}

// 获取或创建用户
function getOrCreateUser(oderId, nickname) {
    if (users.has(oderId)) {
        const user = users.get(oderId);
        if (nickname && nickname !== user.nickname) {
            user.nickname = nickname;
        }
        return user;
    }
    
    // 创建新用户
    const friendCode = generateFriendCode();
    const user = {
        oderId: oderId,
        nickname: nickname || '玩家',
        friendCode: friendCode,
        friends: [],           // 好友列表 [oderId, ...]
        recentPlayers: [],     // 最近一起玩的人 [{oderId, nickname, lastPlayTime, playCount}, ...]
        stats: {
            totalGames: 0,
            wins: 0,
            winStreak: 0,
            maxWinStreak: 0
        },
        createdAt: Date.now()
    };
    
    users.set(oderId, user);
    friendCodes.set(friendCode, oderId);
    console.log(`新用户注册: ${nickname} (${friendCode})`);
    
    // 新用户注册后保存数据
    saveUserData();
    
    return user;
}

// 获取用户的好友列表（带在线状态）
function getFriendList(oderId) {
    const user = users.get(oderId);
    if (!user) return [];
    
    return user.friends.map(friendOderId => {
        const friend = users.get(friendOderId);
        if (!friend) return null;
        
        const isOnline = onlineUsers.has(friendOderId);
        let currentRoom = null;
        
        // 查找好友所在的房间
        if (isOnline) {
            const friendSocketId = onlineUsers.get(friendOderId);
            const room = playerSockets.get(friendSocketId);
            if (room) {
                currentRoom = {
                    code: room.code,
                    playerCount: room.players.filter(p => !p.isBot).length,
                    gameRunning: room.gameRunning
                };
            }
        }
        
        return {
            oderId: friendOderId,
            nickname: friend.nickname,
            friendCode: friend.friendCode,
            isOnline: isOnline,
            currentRoom: currentRoom
        };
    }).filter(f => f !== null);
}

// 添加好友
function addFriend(oderId, friendCode) {
    const user = users.get(oderId);
    if (!user) return { success: false, error: '用户不存在' };
    
    const friendOderId = friendCodes.get(friendCode.toUpperCase());
    if (!friendOderId) return { success: false, error: '好友码不存在' };
    
    if (friendOderId === oderId) return { success: false, error: '不能添加自己' };
    
    if (user.friends.includes(friendOderId)) {
        return { success: false, error: '已经是好友了' };
    }
    
    const friend = users.get(friendOderId);
    if (!friend) return { success: false, error: '好友不存在' };
    
    // 双向添加好友
    user.friends.push(friendOderId);
    friend.friends.push(oderId);
    
    console.log(`好友添加成功: ${user.nickname} <-> ${friend.nickname}`);
    
    // 保存数据
    saveUserData();
    
    return { 
        success: true, 
        friend: {
            oderId: friendOderId,
            nickname: friend.nickname,
            friendCode: friend.friendCode,
            isOnline: onlineUsers.has(friendOderId)
        }
    };
}

// 记录一起玩的人
function recordRecentPlayer(oderId, otherOderId, otherNickname) {
    const user = users.get(oderId);
    if (!user || oderId === otherOderId) return;
    
    const existing = user.recentPlayers.find(p => p.oderId === otherOderId);
    if (existing) {
        existing.lastPlayTime = Date.now();
        existing.playCount++;
        existing.nickname = otherNickname;
    } else {
        user.recentPlayers.unshift({
            oderId: otherOderId,
            nickname: otherNickname,
            lastPlayTime: Date.now(),
            playCount: 1
        });
        // 只保留最近20个
        if (user.recentPlayers.length > 20) {
            user.recentPlayers.pop();
        }
    }
}

// ==================== 结束用户和好友系统 ====================

// 生成6位房间号
function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// 创建一副麻将牌（144 张：万条筒 + 字牌 + 8 花）
function createDeck() {
    const deck = [];
    for (const type of TILE_TYPES) {
        for (const value of TILE_VALUES) {
            for (let i = 0; i < 4; i++) {
                deck.push({ type, value, id: `${type}_${value}_${i}` });
            }
        }
    }
    for (const h of HONOR_VALUES) {
        for (let i = 0; i < 4; i++) {
            deck.push({ type: 'honor', value: h, id: `honor_${h}_${i}` });
        }
    }
    for (const flower of FLOWERS) {
        deck.push({ type: 'flower', value: flower, id: `flower_${flower}` });
    }
    return deck;
}

function isNumberTile(tile) {
    return !!tile && TILE_TYPES.includes(tile.type);
}

function tileKey(tile) {
    if (!tile) return '';
    if (isNumberTile(tile)) return `${tile.type}_${tile.value}`;
    if (tile.type === 'honor') return tile.value;
    return `${tile.type}_${tile.value}`;
}

// 检查是否需补花：季节花 + 中发白（上海规则）
function isFlowerTile(tile) {
    if (!tile) return false;
    if (tile.type === 'flower') return true;
    if (tile.type === 'honor' && JIAN_AS_FLOWER.has(tile.value)) return true;
    return false;
}

// 获取花牌/补花展示名称
function getFlowerName(tile) {
    if (!tile) return '';
    if (tile.type === 'flower') return FLOWER_NAMES[tile.value] || tile.value;
    if (tile.type === 'honor') return HONOR_NAMES[tile.value] || tile.value;
    return String(tile.value);
}

// 洗牌
function shuffleDeck(deck) {
    const shuffled = [...deck];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

// 麻将牌排序（万→条→筒→字）
function sortTiles(tiles) {
    const typeOrder = { wan: 0, tiao: 1, tong: 2, honor: 3, flower: 4 };
    const honorOrder = { dong: 0, nan: 1, xi: 2, bei: 3, zhong: 4, fa: 5, bai: 6 };
    return [...tiles].sort((a, b) => {
        const oa = typeOrder[a.type] !== undefined ? typeOrder[a.type] : 99;
        const ob = typeOrder[b.type] !== undefined ? typeOrder[b.type] : 99;
        if (oa !== ob) return oa - ob;
        if (a.type === 'honor' && b.type === 'honor') {
            return (honorOrder[a.value] ?? 99) - (honorOrder[b.value] ?? 99);
        }
        if (a.type === 'flower' && b.type === 'flower') {
            return String(a.value).localeCompare(String(b.value));
        }
        return (a.value || 0) - (b.value || 0);
    });
}

// 获取牌的显示名称
function getTileName(tile) {
    if (!tile) return '';
    const typeNames = { wan: '万', tiao: '条', tong: '筒' };
    const numNames = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
    if (isNumberTile(tile)) {
        return numNames[tile.value] + typeNames[tile.type];
    }
    if (tile.type === 'honor') {
        return HONOR_NAMES[tile.value] || tile.value;
    }
    if (tile.type === 'flower') {
        return FLOWER_NAMES[tile.value] || tile.value;
    }
    return String(tile.value);
}

// 麻将房间类
class MahjongRoom {
    constructor(code, hostId, hostName) {
        this.code = code;
        this.hostId = hostId;
        this.players = [];
        this.gameState = null;
        this.gameRunning = false;
        this.createdAt = Date.now();
        
        // 计分系统属性
        this.totalRounds = 10;           // 总局数
        this.currentRound = 0;           // 当前局数
        this.matchScores = [0, 0, 0, 0]; // 四个玩家的累计积分
        this.roundHistory = [];          // 每局历史记录
        this.matchStarted = false;       // 比赛是否开始
        this.lastWinnerIndex = -1;       // 上局赢家（用于确定庄家）
        
        console.log(`房间 ${code} 已创建，房主: ${hostName}`);
    }

    // 添加玩家
    addPlayer(socket, username, avatar, voice = 'female01') {
        if (this.players.length >= 4) {
            return null;
        }
        voice = normalizeVoice(voice);
        
        // 检查是否是重连（相同用户名的离线玩家）
        const offlinePlayer = this.players.find(p => !p.isBot && p.offline && p.username === username);
        if (offlinePlayer) {
            // 重连：恢复玩家状态
            offlinePlayer.id = socket.id;
            offlinePlayer.oderId = socket.oderId || offlinePlayer.oderId;  // 更新好友系统ID
            offlinePlayer.socket = socket;
            offlinePlayer.offline = false;
            offlinePlayer.offlineTime = null;
            playerSockets.set(socket.id, this);
            
            console.log(`玩家 ${username} 重连房间 ${this.code}，座位: ${offlinePlayer.seatIndex}`);
            
            // 取消全员离线删除计时器
            if (this.allOfflineTimer) {
                clearTimeout(this.allOfflineTimer);
                this.allOfflineTimer = null;
                console.log(`房间 ${this.code}: 玩家重连，取消删除计时器`);
            }
            
            // 广播玩家重连
            this.broadcast('player_reconnected', { 
                username: username, 
                seatIndex: offlinePlayer.seatIndex 
            });
            this.broadcastRoomUpdate();
            
            // 如果游戏正在进行，发送当前游戏状态并恢复控制权
            if (this.gameRunning) {
                socket.emit('game_started', {
                    gameState: this.getPlayerGameState(socket.id),
                    dealerIndex: this.gameState.dealerIndex,
                    yourSeat: offlinePlayer.seatIndex,
                    currentRound: this.currentRound,
                    totalRounds: this.totalRounds,
                    matchScores: this.matchScores,
                    isReconnect: true,
                    aiTakeover: offlinePlayer.aiTakeover || false  // 告知客户端AI接管状态
                });
                
                // 如果之前被AI接管，通知玩家可以接管
                if (offlinePlayer.aiTakeover) {
                    console.log(`玩家 ${username} 重连，之前被AI接管，可点击接管恢复控制`);
                    setTimeout(() => {
                        socket.emit('need_takeover', {
                            message: 'AI正在代替你进行游戏，点击"接管AI"恢复控制'
                        });
                    }, 500);
                } else {
                    // 【重连恢复控制权】检查是否轮到该玩家
                    if (this.gameState.currentPlayerIndex === offlinePlayer.seatIndex) {
                        console.log(`玩家 ${username} 重连，正好轮到他，恢复控制权`);
                        
                        if (this.gameState.turnPhase === 'discard') {
                            // 出牌阶段：重新设置超时，给玩家时间操作
                            if (this.gameState.discardTimeout) {
                                clearTimeout(this.gameState.discardTimeout);
                            }
                            this.setDiscardTimeout(offlinePlayer);
                            
                            // 通知玩家轮到他出牌（延迟发送确保socket稳定）
                            setTimeout(() => {
                                socket.emit('your_turn', {
                                    phase: 'discard',
                                    message: '轮到你出牌了！'
                                });
                                // 重新发送倒计时
                                socket.emit('discard_countdown', { seconds: 15 });
                            }, 200);
                        } else if (this.gameState.turnPhase === 'draw') {
                            // 摸牌阶段：通知玩家可以摸牌
                            socket.emit('your_turn', {
                                phase: 'draw',
                                message: '轮到你摸牌了！'
                            });
                        }
                    }
                }
                
                // 检查是否有待处理的碰/杠/胡动作
                const pendingAction = this.gameState.pendingActions?.find(a => a.playerId === socket.id);
                if (pendingAction && !pendingAction.resolved) {
                    console.log(`玩家 ${username} 重连，有待处理的动作:`, pendingAction.actions);
                    socket.emit('action_available', {
                        actions: pendingAction.actions,
                        tile: pendingAction.tile
                    });
                }
            }
            
            return offlinePlayer;
        }
        
        const seatIndex = this.players.length;
        const player = {
            id: socket.id,
            oderId: socket.oderId || null,  // 用于好友系统记录
            username: username,
            avatar: avatar || '👤',
            voice: voice || 'female01',  // 语音类型
            socket: socket,
            ready: false,
            seatIndex: seatIndex,
            wind: WINDS[seatIndex],
            isHost: this.players.length === 0,
            isBot: false,
            hand: [],
            melds: [],
            discards: [],
            flowers: [],
            score: 0,
            isTing: false,
            offline: false,
            offlineTime: null
        };
        
        this.players.push(player);
        playerSockets.set(socket.id, this);
        
        console.log(`玩家 ${username} 加入房间 ${this.code}，座位: ${seatIndex}`);
        this.broadcastRoomUpdate();
        
        return player;
    }

    // 添加AI玩家
    addAIPlayer() {
        if (this.players.length >= 4) return null;
        
        const seatIndex = this.players.length;
        const aiNames = ['AI小明', 'AI小红', 'AI小刚', 'AI小丽'];
        const aiAvatars = ['🤖', '🎮', '💻', '🎯'];
        
        // 动态分配 AI 语音，避开已有玩家的语音
        const allVoices = ['female01', 'male'];
        const usedVoices = this.players.map(p => p.voice);
        const availableVoices = allVoices.filter(v => !usedVoices.includes(v));
        // 如果没有可用的就按顺序分配
        const aiVoice = availableVoices.length > 0 
            ? availableVoices[0] 
            : allVoices[seatIndex % 2];
        
        const aiPlayer = {
            id: 'ai_' + Date.now() + '_' + seatIndex,
            username: aiNames[seatIndex] || 'AI玩家',
            avatar: aiAvatars[seatIndex] || '🤖',
            voice: aiVoice,  // 动态分配的 AI 语音
            socket: null,
            ready: true,
            seatIndex: seatIndex,
            wind: WINDS[seatIndex],
            isHost: false,
            isBot: true,
            hand: [],
            melds: [],
            discards: [],
            flowers: [],
            score: 0,
            isTing: false
        };
        
        this.players.push(aiPlayer);
        console.log(`AI玩家 ${aiPlayer.username} 加入房间 ${this.code}`);
        this.broadcastRoomUpdate();
        
        return aiPlayer;
    }

    // 移除玩家
    removePlayer(socketId) {
        const playerIndex = this.players.findIndex(p => p.id === socketId);
        if (playerIndex !== -1) {
            const player = this.players[playerIndex];
            playerSockets.delete(socketId);
            
            // 非AI玩家断线处理（游戏中或等待中都保留位置）
            if (!player.isBot) {
                player.offline = true;
                player.offlineTime = Date.now();
                player.socket = null;
                console.log(`玩家 ${player.username} 断线，等待重连 (房间 ${this.code}, 游戏中: ${this.gameRunning})`);
                
                // 广播玩家离线状态
                this.broadcast('player_offline', { 
                    username: player.username, 
                    seatIndex: player.seatIndex 
                });
                this.broadcastRoomUpdate();
                
                // 如果游戏正在进行且轮到断线玩家，AI立即接管
                if (this.gameRunning && this.gameState.currentPlayerIndex === player.seatIndex) {
                    console.log(`玩家 ${player.username} 断线时正好轮到他，AI接管`);
                    
                    if (this.gameState.discardTimeout) {
                        clearTimeout(this.gameState.discardTimeout);
                        this.gameState.discardTimeout = null;
                    }
                    
                    setTimeout(() => {
                        if (this.gameRunning && player.offline) {
                            this.aiAction(player);
                        }
                    }, 500);
                }
                
                // 等待房间阶段：10分钟后如果还没重连，再移除（微信分享需要时间）
                if (!this.gameRunning) {
                    setTimeout(() => {
                        if (player.offline && !this.gameRunning) {
                            console.log(`玩家 ${player.username} 10分钟未重连，移除`);
                            this.forceRemovePlayer(player);
                        }
                    }, 600000);
                }
                
                return;
            }
            
            // AI玩家直接移除
            this.players.splice(playerIndex, 1);
            console.log(`AI ${player.username} 离开房间 ${this.code}`);
            
            // 重新分配座位
            this.players.forEach((p, idx) => {
                p.seatIndex = idx;
                p.wind = WINDS[idx];
            });
            
            // 如果房主离开，转移房主
            if (player.isHost && this.players.length > 0) {
                const newHost = this.players.find(p => !p.isBot);
                if (newHost) {
                    newHost.isHost = true;
                    this.hostId = newHost.id;
                }
            }
            
            if (this.players.filter(p => !p.isBot).length === 0) {
                this.cleanup();
                gameRooms.delete(this.code);
                console.log(`房间 ${this.code} 已解散（无真人玩家）`);
            } else {
                this.broadcastRoomUpdate();
            }
        }
    }
    
    // 强制移除玩家（用于超时未重连）
    forceRemovePlayer(player) {
        const playerIndex = this.players.findIndex(p => p.username === player.username);
        if (playerIndex === -1) return;
        
        this.players.splice(playerIndex, 1);
        console.log(`玩家 ${player.username} 被强制移除 (房间 ${this.code})`);
        
        // 重新分配座位
        this.players.forEach((p, idx) => {
            p.seatIndex = idx;
            p.wind = WINDS[idx];
        });
        
        // 如果房主离开，转移房主
        if (player.isHost && this.players.length > 0) {
            const newHost = this.players.find(p => !p.isBot);
            if (newHost) {
                newHost.isHost = true;
                this.hostId = newHost.id;
            }
        }
        
        if (this.players.filter(p => !p.isBot).length === 0) {
            this.cleanup();
            gameRooms.delete(this.code);
            console.log(`房间 ${this.code} 已解散（无真人玩家）`);
        } else {
            this.broadcastRoomUpdate();
        }
    }

    // 设置玩家准备状态
    setPlayerReady(socketId, ready) {
        const player = this.players.find(p => p.id === socketId);
        if (player) {
            player.ready = ready;
            player.aiTakeover = false; // 玩家主动准备，取消AI接管标记
            
            // 如果在倒计时中，广播准备状态
            if (this.nextRoundTimer) {
                this.broadcastReadyStatus();
                
                // 检查是否全员准备
                const allReady = this.players.every(p => p.ready);
                if (allReady) {
                    console.log(`房间 ${this.code} 全员准备，立即开始`);
                    clearInterval(this.nextRoundTimer);
                    this.nextRoundTimer = null;
                    
                    setTimeout(() => {
                        if (!this.gameRunning) {
                            this.startGame();
                        }
                    }, 500);
                }
            } else {
                // 非倒计时状态（首局开始前）
                this.broadcastRoomUpdate();
                this.checkCanStart();
            }
        }
    }

    // 填充AI玩家到4人
    fillWithAI() {
        while (this.players.length < 4) {
            this.addAIPlayer();
        }
    }

    // 检查是否可以开始游戏
    checkCanStart() {
        const realPlayers = this.players.filter(p => !p.isBot);
        const allReady = realPlayers.every(p => p.ready);
        
        if (allReady && realPlayers.length >= 1 && !this.gameRunning) {
            // 填充AI到4人
            this.fillWithAI();
            
            // 延迟1秒开始游戏
            setTimeout(() => {
                if (!this.gameRunning) {
                    this.startGame();
                }
            }, 1000);
        }
    }

    // 开始游戏
    startGame() {
        if (this.gameRunning) return;
        
        // 增加局数
        this.currentRound++;
        if (!this.matchStarted) {
            this.matchStarted = true;
            this.matchScores = [0, 0, 0, 0];
            this.roundHistory = [];
            
            // 记录一起玩的人（仅在比赛首次开始时）
            const realPlayers = this.players.filter(p => p.oderId && !p.isBot);
            realPlayers.forEach(player => {
                realPlayers.forEach(other => {
                    if (player.oderId !== other.oderId) {
                        recordRecentPlayer(player.oderId, other.oderId, other.username || '玩家');
                    }
                });
            });
        }
        
        console.log(`房间 ${this.code} 开始第 ${this.currentRound}/${this.totalRounds} 局`);
        this.gameRunning = true;
        
        // 创建并洗牌
        let deck = shuffleDeck(createDeck());
        
        // 庄家：上局赢家当庄，首局随机
        const dealerIndex = (this.lastWinnerIndex >= 0 && this.lastWinnerIndex < this.players.length)
            ? this.lastWinnerIndex
            : Math.floor(Math.random() * 4);
        
        // 初始化游戏状态
        this.gameState = {
            deck: deck,
            dealerIndex: dealerIndex,
            currentPlayerIndex: dealerIndex,
            turnPhase: 'draw', // draw, discard, action
            lastDiscard: null,
            lastDiscardPlayer: -1,
            pendingActions: [], // 等待响应的动作（碰、杠、胡）
            actionTimeout: null,
            discardTimeout: null,    // 【新增】出牌超时计时器
            lastDrawnTile: null,     // 【新增】记录最后摸的牌（用于超时自动出牌）
            pendingDrawAfterGang: false, // 杠后摸牌（用于杠开判定）
            roundNumber: 1,
            gameOver: false
        };
        
        // 发牌：每人13张，庄家14张（花牌自动补花）
        this.players.forEach((player, index) => {
            player.hand = [];
            player.melds = [];
            player.discards = [];
            player.flowers = [];
            player.isTing = false;
            player.ready = false;  // 重置准备状态，以便下一局结束后能重新准备
            
            const cardCount = index === dealerIndex ? 14 : 13;
            for (let i = 0; i < cardCount; i++) {
                this.drawTileForPlayer(player, true); // 发牌阶段
            }
            player.hand = sortTiles(player.hand);
        });
        
        // 广播游戏开始（包含花牌信息）
        this.broadcastGameStart();
        
        // 庄家先出牌
        this.gameState.turnPhase = 'discard';
        this.notifyCurrentPlayer();
    }

    // 广播游戏开始
    broadcastGameStart() {
        this.players.forEach(player => {
            if (player.socket) {
                player.socket.emit('game_started', {
                    gameState: this.getPlayerGameState(player.id),
                    dealerIndex: this.gameState.dealerIndex,
                    yourSeat: player.seatIndex,
                    // 计分系统信息
                    currentRound: this.currentRound,
                    totalRounds: this.totalRounds,
                    matchScores: this.matchScores
                });
            }
        });
    }

    // 获取玩家视角的游戏状态（隐藏其他玩家手牌）- 优化版
    getPlayerGameState(playerId, lightweight = false) {
        const viewingPlayer = this.players.find(p => p.id === playerId);
        
        // 轻量模式：只发送关键变化数据
        if (lightweight) {
            return {
                p: this.players.map(p => ({
                    s: p.seatIndex,           // seat
                    h: p.hand.length,         // handCount
                    d: p.discards.length,     // discardsCount
                    m: p.melds.length,        // meldsCount
                    f: p.flowers?.length || 0, // flowersCount
                    o: p.offline || false     // offline
                })),
                c: this.gameState.currentPlayerIndex,  // current
                t: this.gameState.turnPhase,           // phase
                r: this.gameState.deck.length          // remaining
            };
        }
        
        // 完整模式：初始化或需要完整数据时
        return {
            players: this.players.map(p => ({
                id: p.id,
                username: p.username,
                avatar: p.avatar,
                voice: p.voice || 'female01',  // 语音类型
                seatIndex: p.seatIndex,
                wind: p.wind,
                windName: WIND_NAMES[p.wind],
                isBot: p.isBot,
                isHost: p.isHost,
                offline: p.offline || false,
                aiTakeover: p.aiTakeover || false,  // AI接管状态
                handCount: p.hand.length,
                hand: p.id === playerId ? p.hand : null,
                melds: p.melds,
                discards: p.discards,
                flowers: p.flowers,
                isTing: p.isTing
            })),
            currentPlayerIndex: this.gameState.currentPlayerIndex,
            turnPhase: this.gameState.turnPhase,
            lastDiscard: this.gameState.lastDiscard,
            lastDiscardPlayer: this.gameState.lastDiscardPlayer,
            deckRemaining: this.gameState.deck.length,
            dealerIndex: this.gameState.dealerIndex,
            roundNumber: this.gameState.roundNumber
        };
    }

    // 通知当前玩家行动
    notifyCurrentPlayer() {
        const currentPlayer = this.players[this.gameState.currentPlayerIndex];
        
        // 清除之前的出牌超时计时器
        if (this.gameState.discardTimeout) {
            clearTimeout(this.gameState.discardTimeout);
            this.gameState.discardTimeout = null;
        }
        
        if (currentPlayer.isBot) {
            // AI玩家自动行动（无需等待）
            setTimeout(() => this.aiAction(currentPlayer), 500 + Math.random() * 500);
        } else if (currentPlayer.offline || currentPlayer.aiTakeover) {
            // 离线玩家或被AI接管的玩家当作AI处理
            setTimeout(() => this.aiAction(currentPlayer), 500);
        } else {
            // 真人玩家：如果是出牌阶段，设置15秒超时
            if (this.gameState.turnPhase === 'discard') {
                this.setDiscardTimeout(currentPlayer);
            }
            // 通知真人玩家
            this.broadcastGameState();
        }
    }
    
    // 【新增】设置出牌超时（15秒）
    setDiscardTimeout(player) {
        const DISCARD_TIMEOUT = 15000; // 15秒
        
        this.gameState.discardTimeout = setTimeout(() => {
            if (!this.gameRunning) return;
            if (this.gameState.turnPhase !== 'discard') return;
            if (this.gameState.currentPlayerIndex !== player.seatIndex) return;
            
            console.log(`玩家 ${player.username} 出牌超时，自动出牌`);
            this.autoDiscard(player);
        }, DISCARD_TIMEOUT);
        
        // 通知玩家开始倒计时
        if (player.socket) {
            player.socket.emit('discard_countdown', { seconds: 15 });
        }
    }
    
    // 【新增】自动出牌（打出最后摸的牌，如果没有则打第一张）
    autoDiscard(player) {
        if (!this.gameRunning) {
            console.log('autoDiscard: 游戏未运行，跳过');
            return;
        }
        
        if (player.hand.length === 0) {
            console.log(`autoDiscard: 玩家 ${player.username} 手牌为空，可能流局`);
            // 手牌为空可能是异常情况，检查是否应该结束游戏
            if (this.gameState.deck.length === 0) {
                this.endRound('draw', -1, -1, false, false);
            }
            return;
        }
        
        // 优先打出刚摸的牌
        let tileToDiscard = this.gameState.lastDrawnTile;
        
        // 检查这张牌是否还在手牌中
        if (tileToDiscard) {
            const stillInHand = player.hand.find(t => t.id === tileToDiscard.id);
            if (!stillInHand) {
                tileToDiscard = null;
            }
        }
        
        // 如果没有记录或已不在手牌，打最后一张（刚摸的牌排序后可能在最后）
        if (!tileToDiscard) {
            tileToDiscard = player.hand[player.hand.length - 1];
        }
        
        // 执行出牌
        const tileIndex = player.hand.findIndex(t => t.id === tileToDiscard.id);
        if (tileIndex === -1) {
            console.log(`autoDiscard: 找不到要出的牌，尝试出第一张`);
            tileToDiscard = player.hand[0];
            if (!tileToDiscard) return;
        }
        
        const tile = player.hand.splice(tileIndex, 1)[0];
        player.discards.push(tile);
        player.hand = sortTiles(player.hand);
        
        this.gameState.lastDiscard = tile;
        this.gameState.lastDiscardPlayer = player.seatIndex;
        this.gameState.lastDrawnTile = null;
        this.gameState.lastDrawWasAfterGang = false;
        
        // 广播超时自动出牌
        this.broadcast('tile_discarded', {
            playerIndex: player.seatIndex,
            tile: tile,
            tileName: getTileName(tile),
            isAutoDiscard: true  // 标记为自动出牌
        });
        
        // 通知该玩家
        if (player.socket) {
            player.socket.emit('auto_discard', { 
                tile: tile,
                message: '出牌超时，已自动打出' 
            });
        }
        
        // 检查其他玩家是否可以碰、杠、胡
        this.checkActionsAfterDiscard(tile, player.seatIndex);
    }

    // 广播游戏状态 - 带节流优化
    broadcastGameState(forceFullUpdate = false) {
        const now = Date.now();
        
        // 节流：100ms 内只发送一次（除非强制更新）
        if (!forceFullUpdate && this._lastBroadcast && now - this._lastBroadcast < 100) {
            // 延迟发送，合并多次更新
            if (this._pendingBroadcast) return;
            this._pendingBroadcast = setTimeout(() => {
                this._pendingBroadcast = null;
                this.broadcastGameState(false);
            }, 100);
            return;
        }
        
        this._lastBroadcast = now;
        
        this.players.forEach(player => {
            if (player.socket) {
                player.socket.emit('game_state_update', {
                    gameState: this.getPlayerGameState(player.id)
                });
            }
        });
    }
    
    // 发送轻量级状态更新（用于频繁更新场景）
    broadcastLightUpdate() {
        this.players.forEach(player => {
            if (player.socket) {
                player.socket.emit('light_update', 
                    this.getPlayerGameState(player.id, true)
                );
            }
        });
    }

    // 为玩家摸一张牌（处理花牌补花）
    drawTileForPlayer(player, isDealingPhase = false) {
        if (this.gameState.deck.length === 0) {
            return null;
        }
        
        let tile = this.gameState.deck.pop();
        
        // 如果是花牌，放入花牌区并继续摸
        while (isFlowerTile(tile)) {
            player.flowers.push(tile);
            
            // 游戏中广播补花事件
            if (!isDealingPhase && player.socket) {
                player.socket.emit('flower_drawn', {
                    flower: tile,
                    flowerName: getFlowerName(tile),
                    totalFlowers: player.flowers.length
                });
            }
            
            console.log(`${player.username} 摸到花牌 ${getFlowerName(tile)}，补花中...`);
            
            if (this.gameState.deck.length === 0) {
                return null;
            }
            tile = this.gameState.deck.pop();
        }
        
        player.hand.push(tile);
        return tile;
    }

    // 查找暗杠（手中4张相同的牌）
    findAnGang(player) {
        const counts = {};
        const tiles = {};
        player.hand.forEach(t => {
            const key = `${t.type}_${t.value}`;
            counts[key] = (counts[key] || 0) + 1;
            if (!tiles[key]) tiles[key] = t;
        });
        
        const result = [];
        for (const key in counts) {
            if (counts[key] >= 4) {
                result.push({ key, tile: tiles[key], type: 'an_gang' });
            }
        }
        return result;
    }

    // 查找加杠（已碰的牌，手里摸到第4张）
    findJiaGang(player) {
        const result = [];
        for (const meld of player.melds) {
            if (meld.type === 'peng') {
                const pengTile = meld.tiles[0];
                const matchInHand = player.hand.find(t => 
                    t.type === pengTile.type && t.value === pengTile.value
                );
                if (matchInHand) {
                    result.push({ 
                        tile: matchInHand, 
                        meldIndex: player.melds.indexOf(meld),
                        type: 'jia_gang' 
                    });
                }
            }
        }
        return result;
    }

    // 玩家摸牌
    playerDraw(socketId) {
        const player = this.players.find(p => p.id === socketId);
        if (!player) return;
        
        if (this.gameState.currentPlayerIndex !== player.seatIndex) {
            return { error: '不是你的回合' };
        }
        
        if (this.gameState.turnPhase !== 'draw') {
            return { error: '当前不能摸牌' };
        }
        
        if (this.gameState.deck.length === 0) {
            this.endRound('draw', -1, -1, false, false);
            return;
        }
        
        const drawAfterGang = !!this.gameState.pendingDrawAfterGang;
        this.gameState.pendingDrawAfterGang = false;
        
        const tile = this.drawTileForPlayer(player, false);
        
        if (!tile) {
            this.endRound('draw', -1, -1, false, false);
            return;
        }
        
        // 【新增】记录刚摸的牌（用于超时自动出牌）
        this.gameState.lastDrawnTile = tile;
        this.gameState.lastDrawWasAfterGang = drawAfterGang;
        
        this.gameState.turnPhase = 'discard';
        
        // 检查摸牌后可执行的自身动作（自摸、暗杠、加杠）
        const selfActions = [];
        
        // 检查自摸胡牌
        if (this.canHu(player.hand, player.melds)) {
            selfActions.push('hu_zimo');
        }
        
        // 检查暗杠（未听牌时才能杠）
        const anGangList = (!player.isTing) ? this.findAnGang(player) : [];
        if (anGangList.length > 0) {
            selfActions.push('an_gang');
        }
        
        // 检查加杠（未听牌时才能杠）
        const jiaGangList = (!player.isTing) ? this.findJiaGang(player) : [];
        if (jiaGangList.length > 0) {
            selfActions.push('jia_gang');
        }
        
        if (selfActions.length > 0) {
            this.gameState.pendingZimo = {
                playerId: player.id,
                playerIndex: player.seatIndex,
                tile: tile,
                anGangList: anGangList,
                jiaGangList: jiaGangList
            };
            
            if (player.socket) {
                player.socket.emit('action_available', {
                    playerId: player.id,
                    actions: selfActions,
                    tile: tile,
                    anGangList: anGangList,
                    jiaGangList: jiaGangList
                });
            }
        }
        
        this.broadcastGameState();
        
        // 通知玩家摸到的牌
        if (player.socket) {
            player.socket.emit('tile_drawn', { tile: tile });
        }
        
        // 【新增】设置出牌超时（仅真人玩家）
        if (!player.isBot && !player.offline) {
            this.setDiscardTimeout(player);
        }
        
        return { success: true, tile: tile };
    }

    // 玩家出牌
    playerDiscard(socketId, tileId) {
        const player = this.players.find(p => p.id === socketId);
        if (!player) return { error: '玩家不存在' };
        
        if (this.gameState.currentPlayerIndex !== player.seatIndex) {
            return { error: '不是你的回合' };
        }
        
        if (this.gameState.turnPhase !== 'discard') {
            return { error: '当前不能出牌' };
        }
        
        // 【新增】清除出牌超时计时器
        if (this.gameState.discardTimeout) {
            clearTimeout(this.gameState.discardTimeout);
            this.gameState.discardTimeout = null;
        }
        
        // 清除自摸胡牌状态（玩家选择不胡而是出牌）
        if (this.gameState.pendingZimo) {
            this.gameState.pendingZimo = null;
        }
        
        const tileIndex = player.hand.findIndex(t => t.id === tileId);
        if (tileIndex === -1) {
            return { error: '没有这张牌' };
        }
        
        const tile = player.hand.splice(tileIndex, 1)[0];
        player.discards.push(tile);
        player.hand = sortTiles(player.hand);
        
        this.gameState.lastDiscard = tile;
        this.gameState.lastDiscardPlayer = player.seatIndex;
        this.gameState.lastDrawnTile = null; // 【新增】清除记录
        this.gameState.lastDrawWasAfterGang = false;
        
        // 广播出牌
        this.broadcast('tile_discarded', {
            playerIndex: player.seatIndex,
            tile: tile,
            tileName: getTileName(tile)
        });
        
        // 检查其他玩家是否可以碰、杠、胡
        this.checkActionsAfterDiscard(tile, player.seatIndex);
        
        return { success: true };
    }

    // 检查出牌后其他玩家可以执行的动作
    checkActionsAfterDiscard(tile, discardPlayerIndex) {
        this.gameState.pendingActions = [];
        
        console.log(`检查出牌后动作: ${getTileName(tile)}, 出牌玩家: ${discardPlayerIndex}`);
        
        for (let i = 0; i < 4; i++) {
            if (i === discardPlayerIndex) continue;
            
            const player = this.players[i];
            const actions = [];
            
            // 检查胡牌
            const testHand = [...player.hand, tile];
            if (this.canHu(testHand, player.melds)) {
                actions.push('hu');
            }
            
            // 检查杠（有3张相同的牌）
            const sameCount = player.hand.filter(t => 
                t.type === tile.type && t.value === tile.value
            ).length;
            
            console.log(`玩家 ${player.username} 手中有 ${sameCount} 张 ${getTileName(tile)}, isBot=${player.isBot}, socket=${!!player.socket}, offline=${player.offline}`);
            
            if (sameCount === 3) {
                actions.push('gang');
            }
            
            // 检查碰（有2张相同的牌，且未听牌）
            if (sameCount >= 2 && !player.isTing) {
                actions.push('peng');
            }
            
            if (actions.length > 0) {
                console.log(`玩家 ${player.username} 可执行: ${actions.join(', ')}`);
                this.gameState.pendingActions.push({
                    playerIndex: i,
                    playerId: player.id,
                    actions: actions,
                    tile: tile
                });
            }
        }
        
        console.log(`总共 ${this.gameState.pendingActions.length} 个待处理动作`);
        
        if (this.gameState.pendingActions.length > 0) {
            // 有玩家可以执行动作，等待响应
            this.gameState.turnPhase = 'action';
            this.notifyPendingActions();
            
            // 设置超时（15秒自动过，给玩家更多时间）
            this.gameState.actionTimeout = setTimeout(() => {
                console.log('动作超时，自动解析');
                this.resolveActions();
            }, 15000);
        } else {
            // 没有动作，轮到下家
            this.nextTurn();
        }
    }

    // 通知等待动作的玩家
    notifyPendingActions() {
        let hasHumanPending = false;
        
        this.gameState.pendingActions.forEach(action => {
            const player = this.players[action.playerIndex];
            
            if (player.isBot) {
                // AI决策（延迟执行）
                setTimeout(() => {
                    if (this.gameRunning && !action.resolved) {
                        this.aiDecideAction(player, action);
                    }
                }, 500 + Math.random() * 1000);
            } else if (player.offline || !player.socket || player.aiTakeover) {
                // 离线玩家或被AI接管的玩家：让AI决策（能胡就胡）
                console.log(`玩家 ${player.username} 离线/AI接管，AI代为决策`);
                setTimeout(() => {
                    if (this.gameRunning && !action.resolved) {
                        this.aiDecideAction(player, action);
                    }
                }, 300);
            } else {
                // 真人玩家
                hasHumanPending = true;
                console.log(`通知玩家 ${player.username} 可执行动作:`, action.actions);
                player.socket.emit('action_available', {
                    actions: action.actions,
                    tile: action.tile
                });
            }
        });
        
        this.broadcastGameState();
        
        // 只有在没有真人等待时才检查是否可以立即解析
        if (!hasHumanPending && this.gameState.pendingActions.every(a => a.resolved)) {
            clearTimeout(this.gameState.actionTimeout);
            setTimeout(() => this.resolveActions(), 100);
        }
    }

    // 玩家执行动作（碰、杠、胡、过）
    playerAction(socketId, actionType) {
        const player = this.players.find(p => p.id === socketId);
        if (!player) return { error: '玩家不存在' };
        
        // 处理自摸胡牌
        if (actionType === 'hu_zimo') {
            if (this.gameState.pendingZimo && this.gameState.pendingZimo.playerId === socketId) {
                console.log(`玩家 ${player.username} 自摸胡牌！`);
                // 清除超时计时器
                if (this.gameState.discardTimeout) {
                    clearTimeout(this.gameState.discardTimeout);
                    this.gameState.discardTimeout = null;
                }
                const gangKai = !!this.gameState.lastDrawWasAfterGang;
                // 执行自摸胡牌
                this.endRound('hu', player.seatIndex, -1, true, gangKai);
                this.gameState.pendingZimo = null;
                return { success: true };
            } else {
                return { error: '不能自摸胡牌' };
            }
        }
        
        // 处理暗杠
        if (actionType === 'an_gang') {
            if (this.gameState.pendingZimo && this.gameState.pendingZimo.playerId === socketId) {
                const anGangList = this.gameState.pendingZimo.anGangList;
                if (anGangList && anGangList.length > 0) {
                    console.log(`玩家 ${player.username} 暗杠！`);
                    // 清除超时计时器
                    if (this.gameState.discardTimeout) {
                        clearTimeout(this.gameState.discardTimeout);
                        this.gameState.discardTimeout = null;
                    }
                    this.gameState.pendingZimo = null;
                    this.executeAnGang(player, anGangList[0]);
                    return { success: true };
                }
            }
            return { error: '不能暗杠' };
        }
        
        // 处理加杠
        if (actionType === 'jia_gang') {
            if (this.gameState.pendingZimo && this.gameState.pendingZimo.playerId === socketId) {
                const jiaGangList = this.gameState.pendingZimo.jiaGangList;
                if (jiaGangList && jiaGangList.length > 0) {
                    console.log(`玩家 ${player.username} 加杠！`);
                    // 清除超时计时器
                    if (this.gameState.discardTimeout) {
                        clearTimeout(this.gameState.discardTimeout);
                        this.gameState.discardTimeout = null;
                    }
                    this.gameState.pendingZimo = null;
                    this.executeJiaGang(player, jiaGangList[0]);
                    return { success: true };
                }
            }
            return { error: '不能加杠' };
        }
        
        // 处理自摸后选择 pass（不胡不杠，继续出牌）
        if (actionType === 'pass' && this.gameState.pendingZimo && this.gameState.pendingZimo.playerId === socketId) {
            console.log(`玩家 ${player.username} 跳过自摸/杠，继续出牌`);
            this.gameState.pendingZimo = null;
            this.gameState.lastDrawWasAfterGang = false;
            return { success: true };
        }
        
        const pendingAction = this.gameState.pendingActions.find(a => a.playerId === socketId);
        if (!pendingAction) {
            return { error: '没有可执行的动作' };
        }
        
        if (actionType === 'pass') {
            // 标记为已处理
            pendingAction.resolved = true;
            pendingAction.action = 'pass';
        } else if (pendingAction.actions.includes(actionType)) {
            pendingAction.resolved = true;
            pendingAction.action = actionType;
        } else {
            return { error: '无效的动作' };
        }
        
        // 检查是否所有动作都已处理
        if (this.gameState.pendingActions.every(a => a.resolved)) {
            clearTimeout(this.gameState.actionTimeout);
            this.resolveActions();
        }
        
        return { success: true };
    }

    // 解析所有动作，执行优先级最高的
    resolveActions() {
        // 通知所有玩家隐藏动作按钮
        this.broadcast('action_timeout', {});
        
        // 【修复】将所有未处理的动作自动标记为 pass
        for (const action of this.gameState.pendingActions) {
            if (!action.resolved) {
                console.log(`玩家 ${action.playerIndex} 超时未操作，自动过`);
                action.resolved = true;
                action.action = 'pass';
            }
        }
        
        // 优先级：胡 > 杠 > 碰
        const priority = { hu: 3, gang: 2, peng: 1, pass: 0 };
        
        let bestAction = null;
        for (const action of this.gameState.pendingActions) {
            const actionPriority = priority[action.action] || 0;
            if (!bestAction || actionPriority > priority[bestAction.action]) {
                bestAction = action;
            }
        }
        
        if (bestAction && bestAction.action !== 'pass') {
            this.executeAction(bestAction);
        } else {
            this.nextTurn();
        }
        
        this.gameState.pendingActions = [];
    }

    // 执行暗杠
    executeAnGang(player, gangInfo) {
        const gangKey = gangInfo.key;
        const gangTiles = [];
        player.hand = player.hand.filter(t => {
            if (`${t.type}_${t.value}` === gangKey && gangTiles.length < 4) {
                gangTiles.push(t);
                return false;
            }
            return true;
        });
        
        player.melds.push({
            type: 'gang',
            tiles: gangTiles,
            from: player.seatIndex,
            isAnGang: true
        });
        
        player.hand = sortTiles(player.hand);
        
        this.broadcast('action_executed', {
            playerIndex: player.seatIndex,
            action: 'gang',
            tile: gangInfo.tile,
            tileName: getTileName(gangInfo.tile),
            isAnGang: true
        });
        
        // 杠后摸一张牌
        this.gameState.currentPlayerIndex = player.seatIndex;
        this.gameState.turnPhase = 'draw';
        this.gameState.lastDrawnTile = null;
        this.gameState.pendingDrawAfterGang = true;
        
        this.broadcastGameState();
        this.notifyCurrentPlayer();
    }
    
    // 执行加杠
    executeJiaGang(player, gangInfo) {
        // 从手牌移除这张牌
        const tileIdx = player.hand.findIndex(t => t.id === gangInfo.tile.id);
        if (tileIdx !== -1) {
            player.hand.splice(tileIdx, 1);
        }
        
        // 将碰变成杠
        const meld = player.melds[gangInfo.meldIndex];
        meld.type = 'gang';
        meld.tiles.push(gangInfo.tile);
        meld.isJiaGang = true;
        
        player.hand = sortTiles(player.hand);
        
        this.broadcast('action_executed', {
            playerIndex: player.seatIndex,
            action: 'gang',
            tile: gangInfo.tile,
            tileName: getTileName(gangInfo.tile),
            isJiaGang: true
        });
        
        // 杠后摸一张牌
        this.gameState.currentPlayerIndex = player.seatIndex;
        this.gameState.turnPhase = 'draw';
        this.gameState.lastDrawnTile = null;
        this.gameState.pendingDrawAfterGang = true;
        
        this.broadcastGameState();
        this.notifyCurrentPlayer();
    }

    // 执行动作
    executeAction(action) {
        const player = this.players[action.playerIndex];
        const tile = action.tile;
        
        if (action.action === 'hu') {
            // 点炮胡牌 - 直接用 player 对象，不依赖名字解析
            player.hand.push(tile);
            const loserIndex = this.gameState.lastDiscardPlayer;
            // 从弃牌堆移除
            const discardPlayer = this.players[loserIndex];
            if (discardPlayer && discardPlayer.discards.length > 0) {
                discardPlayer.discards.pop();
            }
            this.endRound('hu', player.seatIndex, loserIndex, false, false);
            
        } else if (action.action === 'peng') {
            // 碰
            const sameTiles = player.hand.filter(t => 
                t.type === tile.type && t.value === tile.value
            ).slice(0, 2);
            
            // 从手牌移除
            sameTiles.forEach(t => {
                const idx = player.hand.findIndex(h => h.id === t.id);
                if (idx !== -1) player.hand.splice(idx, 1);
            });
            
            // 添加到副露
            player.melds.push({
                type: 'peng',
                tiles: [...sameTiles, tile],
                from: this.gameState.lastDiscardPlayer
            });
            
            // 从弃牌堆移除
            const discardPlayer = this.players[this.gameState.lastDiscardPlayer];
            discardPlayer.discards.pop();
            
            // 轮到碰的玩家出牌
            this.gameState.currentPlayerIndex = action.playerIndex;
            this.gameState.turnPhase = 'discard';
            
            this.broadcast('action_executed', {
                playerIndex: action.playerIndex,
                action: 'peng',
                tile: tile,
                tileName: getTileName(tile)
            });
            
            this.broadcastGameState();
            this.notifyCurrentPlayer();
            
        } else if (action.action === 'gang') {
            // 杠
            const sameTiles = player.hand.filter(t => 
                t.type === tile.type && t.value === tile.value
            );
            
            sameTiles.forEach(t => {
                const idx = player.hand.findIndex(h => h.id === t.id);
                if (idx !== -1) player.hand.splice(idx, 1);
            });
            
            player.melds.push({
                type: 'gang',
                tiles: [...sameTiles, tile],
                from: this.gameState.lastDiscardPlayer
            });
            
            const discardPlayer = this.players[this.gameState.lastDiscardPlayer];
            discardPlayer.discards.pop();
            
            this.broadcast('action_executed', {
                playerIndex: action.playerIndex,
                action: 'gang',
                tile: tile,
                tileName: getTileName(tile)
            });
            
            // 杠后摸一张牌
            this.gameState.currentPlayerIndex = action.playerIndex;
            this.gameState.turnPhase = 'draw';
            this.gameState.pendingDrawAfterGang = true;
            
            this.broadcastGameState();
            this.notifyCurrentPlayer();
        }
    }

    // 下一个玩家回合
    nextTurn() {
        this.gameState.currentPlayerIndex = (this.gameState.currentPlayerIndex + 1) % 4;
        this.gameState.turnPhase = 'draw';
        this.gameState.lastDiscard = null;
        
        this.broadcastGameState();
        this.notifyCurrentPlayer();
    }

    // AI行动
    aiAction(aiPlayer) {
        if (!this.gameRunning) {
            console.log('aiAction: 游戏未运行，跳过');
            return;
        }
        
        // 检查是否所有真人玩家都离线了 — 给5分钟重连窗口而不是立即删除
        const onlineRealPlayers = this.players.filter(p => !p.isBot && !p.offline);
        if (onlineRealPlayers.length === 0) {
            if (!this.allOfflineTimer) {
                console.log(`房间 ${this.code}: 所有真人玩家都离线，等待5分钟重连...`);
                this.allOfflineTimer = setTimeout(() => {
                    const stillAllOffline = this.players.filter(p => !p.isBot && !p.offline).length === 0;
                    if (stillAllOffline && this.gameRunning) {
                        console.log(`房间 ${this.code}: 5分钟内无人重连，解散房间`);
                        this.gameRunning = false;
                        this.cleanup();
                        gameRooms.delete(this.code);
                    }
                    this.allOfflineTimer = null;
                }, 300000);
            }
            return;
        }
        if (this.allOfflineTimer) {
            clearTimeout(this.allOfflineTimer);
            this.allOfflineTimer = null;
        }
        
        console.log(`aiAction: 玩家 ${aiPlayer.username} 开始AI行动, 阶段: ${this.gameState.turnPhase}`);
        
        if (this.gameState.turnPhase === 'draw') {
            // 摸牌（包含补花逻辑）
            if (this.gameState.deck.length === 0) {
                this.endRound('draw', -1, -1, false, false);
                return;
            }
            
            const drawAfterGang = !!this.gameState.pendingDrawAfterGang;
            this.gameState.pendingDrawAfterGang = false;
            
            const tile = this.drawTileForPlayer(aiPlayer, false);
            
            if (!tile) {
                this.endRound('draw', -1, -1, false, false);
                return;
            }
            
            this.gameState.lastDrawnTile = tile;
            this.gameState.lastDrawWasAfterGang = drawAfterGang;
            
            // 广播 AI 摸牌（如果有补花也会在 drawTileForPlayer 中处理）
            this.broadcast('ai_draw', {
                playerIndex: aiPlayer.seatIndex,
                playerName: aiPlayer.username,
                flowerCount: aiPlayer.flowers.length
            });
            
            // 检查自摸
            if (this.canHu(aiPlayer.hand, aiPlayer.melds)) {
                const winnerIndex = aiPlayer.seatIndex;
                this.endRound('hu', winnerIndex, -1, true, drawAfterGang);
                return;
            }
            
            // AI 检查暗杠
            const anGangList = this.findAnGang(aiPlayer);
            if (anGangList.length > 0) {
                console.log(`AI ${aiPlayer.username} 暗杠！`);
                this.executeAnGang(aiPlayer, anGangList[0]);
                return;
            }
            
            // AI 检查加杠
            const jiaGangList = this.findJiaGang(aiPlayer);
            if (jiaGangList.length > 0) {
                console.log(`AI ${aiPlayer.username} 加杠！`);
                this.executeJiaGang(aiPlayer, jiaGangList[0]);
                return;
            }
            
            this.gameState.turnPhase = 'discard';
            
            // AI出牌策略：出最不需要的牌
            setTimeout(() => {
                if (this.gameRunning) {
                    this.aiDiscard(aiPlayer);
                }
            }, 500 + Math.random() * 500);
            
        } else if (this.gameState.turnPhase === 'discard') {
            this.aiDiscard(aiPlayer);
        }
    }

    // AI出牌
    aiDiscard(aiPlayer) {
        // 简单策略：出孤张或边张
        const hand = [...aiPlayer.hand];
        let discardTile = null;
        
        const counts = {};
        hand.forEach(t => {
            const key = tileKey(t);
            counts[key] = (counts[key] || 0) + 1;
        });
        
        // 优先出孤张（字牌不参与顺子邻张判断）
        for (const tile of hand) {
            const key = tileKey(tile);
            if (counts[key] === 1) {
                if (isNumberTile(tile)) {
                    const leftKey = `${tile.type}_${tile.value - 1}`;
                    const rightKey = `${tile.type}_${tile.value + 1}`;
                    if (!counts[leftKey] && !counts[rightKey]) {
                        discardTile = tile;
                        break;
                    }
                } else {
                    discardTile = tile;
                    break;
                }
            }
        }
        
        // 没找到就出第一张
        if (!discardTile) {
            discardTile = hand[0];
        }
        
        // 执行出牌
        const tileIndex = aiPlayer.hand.findIndex(t => t.id === discardTile.id);
        if (tileIndex === -1) {
            console.error(`aiDiscard: 找不到要出的牌 ${discardTile?.id}，手牌数: ${aiPlayer.hand.length}`);
            if (aiPlayer.hand.length === 0) return;
            discardTile = aiPlayer.hand[0];
            aiPlayer.hand.splice(0, 1);
        } else {
            aiPlayer.hand.splice(tileIndex, 1);
        }
        aiPlayer.discards.push(discardTile);
        aiPlayer.hand = sortTiles(aiPlayer.hand);
        
        this.gameState.lastDiscard = discardTile;
        this.gameState.lastDiscardPlayer = aiPlayer.seatIndex;
        this.gameState.lastDrawWasAfterGang = false;
        
        this.broadcast('tile_discarded', {
            playerIndex: aiPlayer.seatIndex,
            tile: discardTile,
            tileName: getTileName(discardTile),
            isAI: true
        });
        
        this.checkActionsAfterDiscard(discardTile, aiPlayer.seatIndex);
    }

    // AI决定是否执行动作
    aiDecideAction(aiPlayer, action) {
        // 简单策略：胡必胡，杠必杠，碰概率50%
        if (action.actions.includes('hu')) {
            action.resolved = true;
            action.action = 'hu';
        } else if (action.actions.includes('gang')) {
            action.resolved = true;
            action.action = 'gang';
        } else if (action.actions.includes('peng') && Math.random() > 0.5) {
            action.resolved = true;
            action.action = 'peng';
        } else {
            action.resolved = true;
            action.action = 'pass';
        }
        
        if (this.gameState.pendingActions.every(a => a.resolved)) {
            clearTimeout(this.gameState.actionTimeout);
            this.resolveActions();
        }
    }

    // 七对子（仅门清）
    isQiDui(tiles) {
        if (!tiles || tiles.length !== 14) return false;
        const counts = {};
        tiles.forEach(t => {
            const k = tileKey(t);
            counts[k] = (counts[k] || 0) + 1;
        });
        return Object.keys(counts).length === 7 && Object.values(counts).every(v => v === 2);
    }

    // 十三幺（仅门清）
    isShiSanYao(tiles) {
        if (!tiles || tiles.length !== 14) return false;
        const ORPHAN_KEYS = new Set([
            'wan_1', 'wan_9', 'tiao_1', 'tiao_9', 'tong_1', 'tong_9',
            'dong', 'nan', 'xi', 'bei', 'zhong', 'fa', 'bai'
        ]);
        const counts = {};
        for (const t of tiles) {
            const k = tileKey(t);
            if (!ORPHAN_KEYS.has(k)) return false;
            counts[k] = (counts[k] || 0) + 1;
        }
        if (Object.keys(counts).length !== 13) return false;
        let pairCount = 0;
        for (const k of Object.keys(counts)) {
            const c = counts[k];
            if (c !== 1 && c !== 2) return false;
            if (c === 2) pairCount++;
        }
        return pairCount === 1;
    }

    canHu(hand, melds) {
        const totalTiles = hand.length + melds.length * 3;
        if (totalTiles !== 14) return false;
        if (melds.length === 0) {
            if (this.isQiDui(hand)) return true;
            if (this.isShiSanYao(hand)) return true;
        }
        return this.checkWinningHand([...hand]);
    }

    checkWinningHand(tiles) {
        if (tiles.length === 0) return true;
        if (tiles.length === 2) {
            return tiles[0].type === tiles[1].type && tiles[0].value === tiles[1].value;
        }
        if (tiles.length < 3) return false;

        const sorted = sortTiles(tiles);

        for (let i = 0; i < sorted.length - 1; i++) {
            if (sorted[i].type === sorted[i + 1].type &&
                sorted[i].value === sorted[i + 1].value) {
                const remaining = [...sorted];
                remaining.splice(i, 2);
                if (this.canFormMelds(remaining)) {
                    return true;
                }
            }
        }

        return false;
    }

    canFormMelds(tiles) {
        if (tiles.length === 0) return true;
        if (tiles.length % 3 !== 0) return false;

        const sorted = sortTiles(tiles);

        if (sorted.length >= 3 &&
            sorted[0].type === sorted[1].type && sorted[1].type === sorted[2].type &&
            sorted[0].value === sorted[1].value && sorted[1].value === sorted[2].value) {
            const remaining = sorted.slice(3);
            if (this.canFormMelds(remaining)) return true;
        }

        if (sorted.length >= 3) {
            const first = sorted[0];
            if (isNumberTile(first)) {
                const secondIdx = sorted.findIndex(t =>
                    t.type === first.type && t.value === first.value + 1
                );
                const thirdIdx = sorted.findIndex(t =>
                    t.type === first.type && t.value === first.value + 2
                );

                if (secondIdx !== -1 && thirdIdx !== -1) {
                    const remaining = [...sorted];
                    const indices = [0, secondIdx, thirdIdx].sort((a, b) => b - a);
                    indices.forEach(idx => remaining.splice(idx, 1));
                    if (this.canFormMelds(remaining)) return true;
                }
            }
        }

        return false;
    }

    isQingYiSeAll(allTiles) {
        const suits = new Set();
        for (const t of allTiles) {
            if (isNumberTile(t)) suits.add(t.type);
            else if (t.type === 'honor' || t.type === 'flower') return false;
        }
        return suits.size === 1;
    }

    isHunYiSeAll(allTiles) {
        const suits = new Set();
        let hasHonor = false;
        for (const t of allTiles) {
            if (isNumberTile(t)) suits.add(t.type);
            else if (t.type === 'honor') hasHonor = true;
            else if (t.type === 'flower') return false;
        }
        return suits.size === 1 && hasHonor;
    }

    // ==================== 计分系统（与哈灵单机说明一致）====================

    calculateFan(player, isZimo = false, isGangKai = false, isHaiDiLao = false) {
        const hand = player.hand;
        const melds = player.melds;
        const allTiles = [...hand];
        melds.forEach(meld => {
            allTiles.push(...meld.tiles);
        });

        let fanList = [];
        let totalFan = 0;

        if (melds.length === 0) {
            fanList.push({ name: '门清', fan: 1 });
            totalFan += 1;
        }
        if (isZimo) {
            fanList.push({ name: '自摸', fan: 1 });
            totalFan += 1;
        }
        if (melds.length === 0 && this.isQiDui(hand)) {
            fanList.push({ name: '七对子', fan: 2 });
            totalFan += 2;
        }
        if (this.checkPengPengHu(hand, melds)) {
            fanList.push({ name: '碰碰胡', fan: 2 });
            totalFan += 2;
        }
        if (this.isQingYiSeAll(allTiles)) {
            fanList.push({ name: '清一色', fan: 3 });
            totalFan += 3;
            if (this.checkPengPengHu(hand, melds)) {
                fanList.push({ name: '清碰', fan: 1 });
                totalFan += 1;
            }
        } else if (this.isHunYiSeAll(allTiles)) {
            fanList.push({ name: '混一色', fan: 2 });
            totalFan += 2;
        }
        if (isHaiDiLao) {
            fanList.push({ name: '海底捞', fan: 1 });
            totalFan += 1;
        }
        if (isGangKai) {
            fanList.push({ name: '杠开', fan: 1 });
            totalFan += 1;
        }
        const seasonFlowerCount = (player.flowers || []).filter(f => f && f.type === 'flower').length;
        if (seasonFlowerCount >= 8) {
            fanList.push({ name: '八花报道', fan: 8 });
            totalFan += 8;
        }
        if (totalFan === 0) {
            fanList.push({ name: '平胡', fan: 1 });
            totalFan = 1;
        }

        return { fanList, totalFan };
    }
    
    // 检测碰碰胡
    checkPengPengHu(hand, melds) {
        // 检查副露是否都是刻子或杠
        for (const meld of melds) {
            if (meld.type !== 'peng' && meld.type !== 'gang') {
                return false;
            }
        }
        
        // 检查手牌是否能组成全刻子+一对将
        return this.canFormAllPeng(hand);
    }
    
    // 检查手牌是否能组成全刻子 + 一对将（碰碰胡判定）
    canFormAllPeng(tiles, hasPair = false) {
        if (tiles.length === 0) return hasPair;
        if (tiles.length === 1) return false;
        
        const sorted = sortTiles(tiles);
        
        // 尝试将前三张作为刻子
        if (sorted.length >= 3 &&
            sorted[0].type === sorted[1].type && sorted[1].type === sorted[2].type &&
            sorted[0].value === sorted[1].value && sorted[1].value === sorted[2].value) {
            if (this.canFormAllPeng(sorted.slice(3), hasPair)) return true;
        }
        
        // 尝试将前两张作为将对（每手只能有一对）
        if (!hasPair && sorted.length >= 2 &&
            sorted[0].type === sorted[1].type &&
            sorted[0].value === sorted[1].value) {
            if (this.canFormAllPeng(sorted.slice(2), true)) return true;
        }
        
        return false;
    }
    
    // 计算花数
    calculateHua(player) {
        let huaList = [];
        let totalHua = 1; // 底花1花
        huaList.push({ name: '底花', hua: 1 });
        
        // 统计花牌（每张花牌1花）
        const flowerCount = player.flowers ? player.flowers.length : 0;
        if (flowerCount > 0) {
            huaList.push({ name: `花牌×${flowerCount}`, hua: flowerCount });
            totalHua += flowerCount;
        }
        
        // 统计杠
        for (const meld of player.melds) {
            if (meld.type === 'gang') {
                // 判断明杠还是暗杠
                if (meld.from !== undefined && meld.from !== player.seatIndex) {
                    // 明杠（别人打的牌杠）
                    huaList.push({ name: '明杠', hua: 1 });
                    totalHua += 1;
                } else {
                    // 暗杠
                    huaList.push({ name: '暗杠', hua: 2 });
                    totalHua += 2;
                }
            }
        }
        
        return { huaList, totalHua };
    }
    
    // 计算本局得分
    calculateScore(winner, loserIndex, fanResult, huaResult, isZimo) {
        const MAX_SCORE = 50; // 封顶50分
        
        // 分数 = 花数 × 2^番数
        const baseScore = huaResult.totalHua * Math.pow(2, fanResult.totalFan);
        const finalScore = Math.min(baseScore, MAX_SCORE);
        
        const scoreChanges = [0, 0, 0, 0];
        
        if (isZimo) {
            // 自摸：三家各付分数
            for (let i = 0; i < 4; i++) {
                if (i === winner.seatIndex) {
                    scoreChanges[i] = finalScore * 3;
                } else {
                    scoreChanges[i] = -finalScore;
                }
            }
        } else {
            // 点炮：放炮者付全部分数
            scoreChanges[winner.seatIndex] = finalScore * 3;
            scoreChanges[loserIndex] = -finalScore * 3;
        }
        
        return {
            baseScore,
            finalScore,
            scoreChanges,
            fanDetail: fanResult.fanList,
            huaDetail: huaResult.huaList,
            totalFan: fanResult.totalFan,
            totalHua: huaResult.totalHua
        };
    }

    // 结束一局（胡牌或流局）
    endRound(resultType, winnerIndex = -1, loserIndex = -1, isZimo = false, isGangKai = false) {
        this.gameRunning = false;
        this.gameState.gameOver = true;
        
        // 清除所有超时计时器
        if (this.gameState.actionTimeout) {
            clearTimeout(this.gameState.actionTimeout);
        }
        if (this.gameState.discardTimeout) {
            clearTimeout(this.gameState.discardTimeout);
        }
        
        let roundResult = {
            round: this.currentRound,
            resultType: resultType, // 'hu', 'zimo', 'draw'（流局）
            winnerIndex: winnerIndex,
            loserIndex: loserIndex,
            scoreResult: null,
            players: []
        };
        
        // 如果有人胡牌，计算积分
        if (winnerIndex >= 0) {
            const winner = this.players[winnerIndex];
            const haiDiLao = this.gameState.deck.length === 0;
            const fanResult = this.calculateFan(winner, isZimo, isGangKai, haiDiLao);
            const huaResult = this.calculateHua(winner);
            const scoreResult = this.calculateScore(winner, loserIndex, fanResult, huaResult, isZimo);
            
            // 更新累计积分
            for (let i = 0; i < 4; i++) {
                this.matchScores[i] += scoreResult.scoreChanges[i];
            }
            
            roundResult.scoreResult = scoreResult;
            this.lastWinnerIndex = winnerIndex;
        }
        
        // 记录玩家信息
        roundResult.players = this.players.map((p, idx) => ({
            username: p.username,
            seatIndex: p.seatIndex,
            hand: p.hand,
            melds: p.melds,
            roundScore: roundResult.scoreResult ? roundResult.scoreResult.scoreChanges[idx] : 0,
            totalScore: this.matchScores[idx]
        }));
        
        // 保存历史记录
        this.roundHistory.push(roundResult);
        
        // 判断是否结束比赛
        if (this.currentRound >= this.totalRounds) {
            // 10局结束，广播比赛结束
            this.endMatch();
        } else {
            // 重置所有玩家准备状态
            this.players.forEach(p => {
                p.ready = false;
                // 标记是否被AI接管（用于后续恢复）
                if (!p.isBot && !p.offline) {
                    p.aiTakeover = false;
                }
            });
            
            // 广播本局结束，包含30秒倒计时
            this.broadcast('round_ended', {
                roundResult: roundResult,
                currentRound: this.currentRound,
                totalRounds: this.totalRounds,
                matchScores: this.matchScores,
                countdownSeconds: 30
            });
            
            // 启动30秒倒计时
            this.startNextRoundCountdown();
        }
    }
    
    // 启动下一局倒计时
    startNextRoundCountdown() {
        const COUNTDOWN_SECONDS = 30;
        this.nextRoundCountdown = COUNTDOWN_SECONDS;
        
        // 清除之前的倒计时
        if (this.nextRoundTimer) {
            clearInterval(this.nextRoundTimer);
        }
        
        // AI玩家立即准备
        this.players.forEach(p => {
            if (p.isBot) {
                p.ready = true;
            }
        });
        
        // 广播初始准备状态
        this.broadcastReadyStatus();
        
        // 每秒更新倒计时
        this.nextRoundTimer = setInterval(() => {
            this.nextRoundCountdown--;
            
            // 广播倒计时
            this.broadcast('countdown_update', {
                seconds: this.nextRoundCountdown,
                readyStatus: this.getReadyStatus()
            });
            
            if (this.nextRoundCountdown <= 0) {
                clearInterval(this.nextRoundTimer);
                this.nextRoundTimer = null;
                this.forceStartNextRound();
            }
        }, 1000);
    }
    
    // 获取玩家准备状态
    getReadyStatus() {
        return this.players.map(p => ({
            seatIndex: p.seatIndex,
            username: p.username,
            ready: p.ready,
            isBot: p.isBot,
            aiTakeover: p.aiTakeover || false
        }));
    }
    
    // 广播准备状态
    broadcastReadyStatus() {
        this.broadcast('ready_status_update', {
            readyStatus: this.getReadyStatus(),
            countdown: this.nextRoundCountdown
        });
    }
    
    // 强制开始下一局（倒计时结束）
    forceStartNextRound() {
        console.log(`房间 ${this.code} 倒计时结束，强制开始下一局`);
        
        // 未准备的真人玩家由AI接管
        this.players.forEach(p => {
            if (!p.isBot && !p.ready && !p.offline) {
                console.log(`玩家 ${p.username} 未准备，AI接管`);
                p.aiTakeover = true;
                p.ready = true; // 标记为准备好，以便开始游戏
            }
        });
        
        // 广播AI接管状态
        this.broadcast('ai_takeover_status', {
            readyStatus: this.getReadyStatus()
        });
        
        // 开始下一局
        setTimeout(() => {
            if (!this.gameRunning) {
                this.startGame();
            }
        }, 500);
    }
    
    // 玩家接管AI（游戏中恢复控制权）
    takeoverAI(socketId) {
        const player = this.players.find(p => p.id === socketId);
        if (!player) return { error: '玩家不存在' };
        
        if (!player.aiTakeover) {
            return { error: '你没有被AI接管' };
        }
        
        console.log(`玩家 ${player.username} 接管AI，恢复控制权`);
        player.aiTakeover = false;
        
        // 通知该玩家恢复控制
        if (player.socket) {
            player.socket.emit('takeover_success', {
                message: '已恢复控制权！',
                seatIndex: player.seatIndex
            });
        }
        
        // 广播状态更新
        this.broadcast('player_takeover', {
            username: player.username,
            seatIndex: player.seatIndex
        });
        
        // 如果正好轮到这个玩家，设置出牌超时
        if (this.gameState.currentPlayerIndex === player.seatIndex && 
            this.gameState.turnPhase === 'discard') {
            this.setDiscardTimeout(player);
        }
        
        this.broadcastGameState();
        
        return { success: true };
    }
    
    // 结束整场比赛
    endMatch() {
        // 计算最终排名
        const ranking = this.players.map((p, idx) => ({
            username: p.username,
            seatIndex: idx,
            totalScore: this.matchScores[idx],
            isBot: p.isBot,
            oderId: p.oderId
        })).sort((a, b) => b.totalScore - a.totalScore);
        
        // 更新玩家统计数据
        const winnerOderId = ranking[0].oderId;  // 第一名是赢家
        this.players.forEach(player => {
            if (player.oderId && !player.isBot) {
                const user = users.get(player.oderId);
                if (user) {
                    user.stats.totalGames++;
                    
                    // 判断是否是赢家（第一名）
                    if (player.oderId === winnerOderId) {
                        user.stats.wins++;
                        user.stats.winStreak++;
                        if (user.stats.winStreak > user.stats.maxWinStreak) {
                            user.stats.maxWinStreak = user.stats.winStreak;
                        }
                    } else {
                        user.stats.winStreak = 0;  // 重置连胜
                    }
                    
                    console.log(`更新玩家 ${player.username} 统计: 总局数=${user.stats.totalGames}, 胜场=${user.stats.wins}`);
                }
            }
        });
        
        // 保存统计数据
        saveUserData();
        
        // 广播比赛结束
        this.broadcast('match_ended', {
            ranking: ranking,
            matchScores: this.matchScores,
            roundHistory: this.roundHistory,
            totalRounds: this.totalRounds
        });
        
        // 重置比赛状态
        this.matchStarted = false;
        this.currentRound = 0;
        this.matchScores = [0, 0, 0, 0];
        this.roundHistory = [];
        
        // 重置准备状态
        this.players.forEach(p => {
            if (!p.isBot) p.ready = false;
        });
        
        this.broadcastRoomUpdate();
    }
    
    // 旧版结束游戏（保留兼容）
    endGame(result) {
        // 解析结果判断胡牌类型
        if (result.includes('自摸')) {
            const winnerName = result.split(' ')[0];
            const winner = this.players.find(p => p.username === winnerName);
            if (winner) {
                this.endRound('zimo', winner.seatIndex, -1, true, false);
                return;
            }
        } else if (result.includes('胡牌')) {
            const winnerName = result.split(' ')[0];
            const winner = this.players.find(p => p.username === winnerName);
            if (winner) {
                // 点炮者是上一个出牌的人
                const loserIndex = this.gameState.lastDiscardPlayer;
                this.endRound('hu', winner.seatIndex, loserIndex, false, false);
                return;
            }
        } else if (result.includes('流局')) {
            this.endRound('draw', -1, -1, false, false);
            return;
        }
        
        // 默认处理
        this.endRound('draw', -1, -1, false, false);
    }

    // 广播房间更新
    broadcastRoomUpdate() {
        const roomInfo = {
            code: this.code,
            hostId: this.hostId,
            gameRunning: this.gameRunning,
            players: this.players.map(p => ({
                id: p.id,
                username: p.username,
                avatar: p.avatar,
                voice: p.voice || 'female01',  // 语音类型
                seatIndex: p.seatIndex,
                wind: p.wind,
                windName: WIND_NAMES[p.wind],
                ready: p.ready,
                isHost: p.isHost,
                isBot: p.isBot
            }))
        };
        
        this.broadcast('room_updated', { room: roomInfo });
    }

    // 广播消息给所有玩家
    broadcast(event, data) {
        this.players.forEach(player => {
            if (player.socket) {
                player.socket.emit(event, data);
            }
        });
    }

    // 清理资源
    cleanup() {
        if (this.allOfflineTimer) {
            clearTimeout(this.allOfflineTimer);
            this.allOfflineTimer = null;
        }
        if (this.gameState) {
            if (this.gameState.actionTimeout) {
                clearTimeout(this.gameState.actionTimeout);
            }
            if (this.gameState.discardTimeout) {
                clearTimeout(this.gameState.discardTimeout);
            }
        }
    }
}

// Socket.IO 事件处理
io.on('connection', (socket) => {
    console.log('新连接:', socket.id);
    
    // ==================== 用户和好友事件 ====================
    
    // 用户登录/注册（获取或创建用户）
    socket.on('user_login', (data) => {
        const { oderId, nickname } = data;
        if (!oderId) {
            socket.emit('login_error', { error: '缺少用户ID' });
            return;
        }
        
        const user = getOrCreateUser(oderId, nickname);
        onlineUsers.set(oderId, socket.id);
        socket.oderId = oderId;
        
        socket.emit('login_success', {
            oderId: user.oderId,
            nickname: user.nickname,
            friendCode: user.friendCode,
            stats: user.stats,
            friendCount: user.friends.length
        });
        
        // 通知好友上线
        user.friends.forEach(friendOderId => {
            const friendSocketId = onlineUsers.get(friendOderId);
            if (friendSocketId) {
                io.to(friendSocketId).emit('friend_online', {
                    oderId: user.oderId,
                    nickname: user.nickname
                });
            }
        });
        
        console.log(`用户上线: ${user.nickname} (${user.friendCode})`);
    });
    
    // 获取好友列表
    socket.on('get_friends', () => {
        if (!socket.oderId) {
            socket.emit('friends_list', { friends: [], recentPlayers: [] });
            return;
        }
        
        const user = users.get(socket.oderId);
        if (!user) {
            socket.emit('friends_list', { friends: [], recentPlayers: [] });
            return;
        }
        
        const friends = getFriendList(socket.oderId);
        const recentPlayers = user.recentPlayers.map(p => {
            const isOnline = onlineUsers.has(p.oderId);
            const isFriend = user.friends.includes(p.oderId);
            return {
                ...p,
                isOnline,
                isFriend
            };
        });
        
        socket.emit('friends_list', { friends, recentPlayers });
    });
    
    // 添加好友
    socket.on('add_friend', (data) => {
        const { friendCode } = data;
        if (!socket.oderId) {
            socket.emit('add_friend_result', { success: false, error: '请先登录' });
            return;
        }
        
        const result = addFriend(socket.oderId, friendCode);
        socket.emit('add_friend_result', result);
        
        // 如果成功，通知对方
        if (result.success) {
            const user = users.get(socket.oderId);
            const friendSocketId = onlineUsers.get(result.friend.oderId);
            if (friendSocketId) {
                io.to(friendSocketId).emit('friend_added', {
                    oderId: user.oderId,
                    nickname: user.nickname,
                    friendCode: user.friendCode
                });
            }
        }
    });
    
    // 获取好友状态（实时查询某个好友的状态）
    socket.on('get_friend_status', (data) => {
        const { friendOderId } = data;
        const isOnline = onlineUsers.has(friendOderId);
        let currentRoom = null;
        
        if (isOnline) {
            const friendSocketId = onlineUsers.get(friendOderId);
            const room = playerSockets.get(friendSocketId);
            if (room) {
                currentRoom = {
                    code: room.code,
                    playerCount: room.players.filter(p => !p.isBot).length,
                    gameRunning: room.gameRunning
                };
            }
        }
        
        socket.emit('friend_status', {
            oderId: friendOderId,
            isOnline,
            currentRoom
        });
    });
    
    // 获取用户统计数据
    socket.on('get_stats', () => {
        if (!socket.oderId) {
            socket.emit('user_stats', { stats: null });
            return;
        }
        
        const user = users.get(socket.oderId);
        if (!user) {
            socket.emit('user_stats', { stats: null });
            return;
        }
        
        const winRate = user.stats.totalGames > 0 
            ? Math.round((user.stats.wins / user.stats.totalGames) * 100) 
            : 0;
        
        socket.emit('user_stats', {
            stats: {
                totalGames: user.stats.totalGames,
                wins: user.stats.wins,
                winRate: winRate,
                winStreak: user.stats.winStreak,
                maxWinStreak: user.stats.maxWinStreak
            }
        });
    });
    
    // ==================== 结束用户和好友事件 ====================

    // 创建房间
    socket.on('create_room', (data) => {
        const { username, avatar, voice } = data;
        let code;
        do {
            code = generateRoomCode();
        } while (gameRooms.has(code));
        
        const room = new MahjongRoom(code, socket.id, username);
        gameRooms.set(code, room);
        
        room.addPlayer(socket, username, avatar, normalizeVoice(voice));
        
        socket.emit('room_created', { roomCode: code });
    });

    // 加入房间
    socket.on('join_room', (data) => {
        const { roomCode, username, avatar, voice } = data;
        const code = roomCode.toUpperCase().trim();
        const room = gameRooms.get(code);
        
        console.log(`玩家 ${username} (${voice || 'female01'}) 尝试加入房间 ${code}, 当前房间数: ${gameRooms.size}`);
        
        if (!room) {
            // 列出所有房间供调试
            const allRooms = Array.from(gameRooms.keys());
            console.log('当前所有房间:', allRooms);
            socket.emit('join_error', { message: `房间 ${code} 不存在，请确认房间号是否正确` });
            return;
        }
        
        // 游戏进行中：仅允许断线重连（匹配同名离线玩家）
        if (room.gameRunning) {
            const offlinePlayer = room.players.find(p => !p.isBot && p.offline && p.username === username);
            if (!offlinePlayer) {
                socket.emit('join_error', { message: '游戏已开始，无法加入' });
                return;
            }
            console.log(`玩家 ${username} 断线重连中（游戏进行中），允许加入`);
            room.addPlayer(socket, username, avatar, normalizeVoice(voice));
            socket.emit('room_joined', { roomCode: room.code });
            return;
        }
        
        // 检查真人玩家数量（AI不占位）
        const realPlayerCount = room.players.filter(p => !p.isBot).length;
        if (realPlayerCount >= 4) {
            socket.emit('join_error', { message: '房间已满（4人）' });
            return;
        }
        
        // 如果有AI，踢掉一个AI腾位置
        if (room.players.length >= 4) {
            const botIndex = room.players.findIndex(p => p.isBot);
            if (botIndex !== -1) {
                room.players.splice(botIndex, 1);
                console.log('踢掉一个AI玩家，为真人腾位置');
            }
        }
        
        room.addPlayer(socket, username, avatar, normalizeVoice(voice));
        socket.emit('room_joined', { roomCode: room.code });
        console.log(`玩家 ${username} 成功加入房间 ${code}`);
    });

    // 准备/取消准备
    socket.on('toggle_ready', (data) => {
        const room = playerSockets.get(socket.id);
        if (room) {
            room.setPlayerReady(socket.id, data.ready);
        }
    });
    
    // 接管AI（游戏中恢复控制权）
    socket.on('takeover_ai', () => {
        const room = playerSockets.get(socket.id);
        if (room && room.gameRunning) {
            room.takeoverAI(socket.id);
        }
    });
    
    // 房间聊天
    socket.on('chat_message', (data) => {
        if (!data) return;
        
        const room = playerSockets.get(socket.id);
        if (room) {
            const player = room.players.find(p => p.id === socket.id);
            if (player) {
                const text = data.text || data.message || '';
                if (!text) return;
                
                const message = {
                    username: player.username,
                    seatIndex: player.seatIndex,
                    text: String(text).substring(0, 100), // 限制长度
                    timestamp: Date.now()
                };
                // 广播给房间内所有人
                room.broadcast('chat_message', message);
                console.log(`[聊天] ${player.username}: ${message.text}`);
            }
        }
    });
    
    // 修改昵称
    socket.on('change_nickname', (data) => {
        if (!data || !data.nickname) return;
        
        const room = playerSockets.get(socket.id);
        if (room) {
            const player = room.players.find(p => p.id === socket.id);
            if (player) {
                const oldName = player.username;
                const newNickname = String(data.nickname).substring(0, 12); // 限制长度
                player.username = newNickname;
                // 保存到localStorage提示
                socket.emit('nickname_changed', { nickname: player.username });
                // 通知其他玩家
                room.broadcast('player_renamed', { 
                    oldName: oldName, 
                    newName: player.username,
                    seatIndex: player.seatIndex
                });
                room.broadcastRoomUpdate();
            }
        }
    });

    // 离开房间
    socket.on('leave_room', () => {
        const room = playerSockets.get(socket.id);
        if (room) {
            room.removePlayer(socket.id);
        }
    });

    // 摸牌
    socket.on('draw_tile', () => {
        const room = playerSockets.get(socket.id);
        if (room && room.gameRunning) {
            const result = room.playerDraw(socket.id);
            if (result && result.error) {
                socket.emit('action_error', { message: result.error });
            }
        }
    });

    // 出牌
    socket.on('discard_tile', (data) => {
        const room = playerSockets.get(socket.id);
        if (room && room.gameRunning) {
            const result = room.playerDiscard(socket.id, data.tileId);
            if (result && result.error) {
                socket.emit('action_error', { message: result.error });
            }
        }
    });
    
    // 确认听牌
    socket.on('confirm_ting', (data) => {
        const room = playerSockets.get(socket.id);
        if (room && room.gameRunning) {
            const player = room.players.find(p => p.id === socket.id);
            if (player) {
                player.isTing = true;
                player.tingList = data.tingList || [];
                console.log(`玩家 ${player.username} 确认听牌，听牌列表:`, player.tingList.length, '张');
            }
        }
    });

    // 执行动作（碰、杠、胡、过）
    socket.on('player_action', (data) => {
        const room = playerSockets.get(socket.id);
        if (room && room.gameRunning) {
            const result = room.playerAction(socket.id, data.action);
            if (result && result.error) {
                socket.emit('action_error', { message: result.error });
            }
        }
    });
    
    // Ping/Pong 网络质量检测
    socket.on('ping', () => {
        socket.emit('pong');
    });
    
    // 请求完整状态同步（页面恢复可见时）
    socket.on('request_sync', () => {
        const room = playerSockets.get(socket.id);
        if (room && room.gameRunning) {
            const player = room.players.find(p => p.id === socket.id);
            if (player) {
                socket.emit('game_state_update', {
                    gameState: room.getPlayerGameState(socket.id)
                });
            }
        }
    });

    // 断开连接
    socket.on('disconnect', () => {
        console.log('断开连接:', socket.id);
        
        // 处理好友下线通知
        if (socket.oderId) {
            const user = users.get(socket.oderId);
            if (user) {
                // 通知好友下线
                user.friends.forEach(friendOderId => {
                    const friendSocketId = onlineUsers.get(friendOderId);
                    if (friendSocketId) {
                        io.to(friendSocketId).emit('friend_offline', {
                            oderId: user.oderId,
                            nickname: user.nickname
                        });
                    }
                });
            }
            onlineUsers.delete(socket.oderId);
        }
        
        const room = playerSockets.get(socket.id);
        if (room) {
            room.removePlayer(socket.id);
        }
    });
});

// 定期清理空房间
setInterval(() => {
    const now = Date.now();
    for (const [code, room] of gameRooms) {
        // 清理超过2小时的空房间
        if (room.players.filter(p => !p.isBot).length === 0 || 
            now - room.createdAt > 7200000) {
            room.cleanup();
            gameRooms.delete(code);
            console.log(`清理过期房间: ${code}`);
        }
    }
}, 60000);

// ==================== 五子棋游戏逻辑 ====================

// 五子棋房间管理
const gomokuRooms = new Map();
const gomokuPlayerSockets = new Map();

// 生成6位房间号（五子棋专用，避免与麻将冲突）
function generateGomokuRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = 'G'; // G开头表示五子棋
    for (let i = 0; i < 5; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// 五子棋房间类
class GomokuRoom {
    constructor(code, hostId, hostName) {
        this.code = code;
        this.players = [];
        this.board = null;
        this.gameRunning = false;
        this.currentTurn = 'black';
        this.createdAt = Date.now();
        this.moveHistory = []; // 落子历史记录
        this.undoUsed = { black: false, white: false }; // 每方只能悔棋一次
        this.pendingUndo = null; // 待处理的悔棋请求
        console.log(`[五子棋] 房间 ${code} 已创建，房主: ${hostName}`);
    }

    addPlayer(socket, username, avatar) {
        // 重连检查：相同昵称的离线玩家
        const offlinePlayer = this.players.find(p => p.offline && p.username === username);
        if (offlinePlayer) {
            gomokuPlayerSockets.delete(offlinePlayer.id);
            offlinePlayer.id = socket.id;
            offlinePlayer.socket = socket;
            offlinePlayer.avatar = avatar || offlinePlayer.avatar;
            offlinePlayer.offline = false;
            offlinePlayer.offlineTime = null;
            gomokuPlayerSockets.set(socket.id, this);

            console.log(`[五子棋] 玩家 ${username} 重连房间 ${this.code}`);
            this.broadcast('player_reconnected', { username });
            this.broadcastRoomUpdate();

            if (this.gameRunning) {
                const blackP = this.players.find(p => p.color === 'black');
                const whiteP = this.players.find(p => p.color === 'white');
                socket.emit('game_reconnect', {
                    yourColor: offlinePlayer.color,
                    board: this.board,
                    currentTurn: this.currentTurn,
                    moveHistory: this.moveHistory,
                    blackPlayer: blackP ? blackP.username : '黑方',
                    blackAvatar: blackP ? blackP.avatar || '' : '',
                    whitePlayer: whiteP ? whiteP.username : '白方',
                    whiteAvatar: whiteP ? whiteP.avatar || '' : ''
                });
            }
            return offlinePlayer;
        }

        const onlineCount = this.players.filter(p => !p.offline).length;
        if (onlineCount >= 2) return null;

        const player = {
            id: socket.id,
            username: username,
            avatar: avatar || '',
            socket: socket,
            ready: false,
            offline: false,
            offlineTime: null,
            color: this.players.length === 0 ? 'black' : 'white'
        };
        
        this.players.push(player);
        gomokuPlayerSockets.set(socket.id, this);
        
        console.log(`[五子棋] 玩家 ${username} 加入房间 ${this.code}，执${player.color === 'black' ? '黑' : '白'}子`);
        this.broadcastRoomUpdate();
        return player;
    }

    removePlayer(socketId) {
        const playerIndex = this.players.findIndex(p => p.id === socketId);
        if (playerIndex !== -1) {
            const player = this.players[playerIndex];
            gomokuPlayerSockets.delete(socketId);

            // 标记为离线而非立即移除，给予重连宽限期
            player.offline = true;
            player.offlineTime = Date.now();
            player.socket = null;
            console.log(`[五子棋] 玩家 ${player.username} 断线，等待重连 (房间 ${this.code}, 游戏中: ${this.gameRunning})`);

            this.broadcast('player_offline', { username: player.username, color: player.color });
            this.broadcastRoomUpdate();

            const gracePeriod = this.gameRunning ? 180000 : 60000; // 游戏中3分钟，等待中1分钟
            setTimeout(() => {
                if (player.offline) {
                    console.log(`[五子棋] 玩家 ${player.username} 超时未重连，移除`);
                    this.forceRemovePlayer(player);
                }
            }, gracePeriod);
        }
    }

    forceRemovePlayer(player) {
        const idx = this.players.findIndex(p => p.username === player.username);
        if (idx === -1) return;
        this.players.splice(idx, 1);

        if (this.gameRunning) {
            this.broadcast('opponent_left', {});
            this.gameRunning = false;
        }

        if (this.players.length === 1) {
            this.players[0].color = 'black';
            this.players[0].ready = false;
        }

        if (this.players.filter(p => !p.offline).length === 0) {
            gomokuRooms.delete(this.code);
            console.log(`[五子棋] 房间 ${this.code} 已解散（无在线玩家）`);
        } else {
            this.broadcastRoomUpdate();
        }
    }

    setPlayerReady(socketId, ready) {
        const player = this.players.find(p => p.id === socketId);
        if (player) {
            player.ready = ready;
            this.broadcastRoomUpdate();
            
            if (this.players.length === 2 && this.players.every(p => p.ready)) {
                this.startGame();
            }
        }
    }

    startGame() {
        this.gameRunning = true;
        this.board = Array(15).fill(null).map(() => Array(15).fill(null));
        this.currentTurn = 'black';
        this.moveHistory = []; // 重置落子历史
        this.undoUsed = { black: false, white: false }; // 重置悔棋次数
        this.pendingUndo = null;
        
        // 随机分配颜色
        if (Math.random() > 0.5) {
            [this.players[0].color, this.players[1].color] = 
            [this.players[1].color, this.players[0].color];
        }
        
        const blackPlayer = this.players.find(p => p.color === 'black');
        const whitePlayer = this.players.find(p => p.color === 'white');
        
        this.players.forEach(player => {
            player.socket.emit('game_started', {
                yourColor: player.color,
                blackPlayer: blackPlayer.username,
                blackAvatar: blackPlayer.avatar || '',
                whitePlayer: whitePlayer.username,
                whiteAvatar: whitePlayer.avatar || ''
            });
        });
        
        console.log(`[五子棋] 房间 ${this.code} 游戏开始！黑方: ${blackPlayer.username}, 白方: ${whitePlayer.username}`);
    }

    placeStone(socketId, row, col) {
        const player = this.players.find(p => p.id === socketId);
        if (!player) return { error: '玩家不存在' };
        if (!this.gameRunning) return { error: '游戏未开始' };
        if (player.color !== this.currentTurn) return { error: '还没轮到你' };
        if (this.board[row][col]) return { error: '这里已经有棋子了' };
        
        this.board[row][col] = player.color;
        
        // 记录落子历史
        this.moveHistory.push({
            row, col,
            color: player.color,
            playerId: socketId
        });
        
        this.broadcast('stone_placed', {
            row, col,
            color: player.color,
            nextColor: player.color === 'black' ? 'white' : 'black'
        });
        
        const winResult = this.checkWin(row, col, player.color);
        if (winResult.win) {
            this.gameRunning = false;
            this.broadcast('game_over', {
                winner: player.color,
                winnerName: player.username,
                winningCells: winResult.cells
            });
            console.log(`[五子棋] 房间 ${this.code} 游戏结束，${player.username} 获胜！`);
            return { success: true, gameOver: true };
        }
        
        if (this.isBoardFull()) {
            this.gameRunning = false;
            this.broadcast('game_over', { winner: null, draw: true });
            return { success: true, gameOver: true, draw: true };
        }
        
        this.currentTurn = this.currentTurn === 'black' ? 'white' : 'black';
        return { success: true };
    }

    checkWin(row, col, color) {
        const directions = [
            [[0, 1], [0, -1]], [[1, 0], [-1, 0]],
            [[1, 1], [-1, -1]], [[1, -1], [-1, 1]]
        ];
        
        for (const [dir1, dir2] of directions) {
            let count = 1;
            const cells = [[row, col]];
            
            let r = row + dir1[0], c = col + dir1[1];
            while (r >= 0 && r < 15 && c >= 0 && c < 15 && this.board[r][c] === color) {
                count++; cells.push([r, c]);
                r += dir1[0]; c += dir1[1];
            }
            
            r = row + dir2[0]; c = col + dir2[1];
            while (r >= 0 && r < 15 && c >= 0 && c < 15 && this.board[r][c] === color) {
                count++; cells.push([r, c]);
                r += dir2[0]; c += dir2[1];
            }
            
            if (count >= 5) return { win: true, cells };
        }
        return { win: false };
    }

    isBoardFull() {
        for (let row = 0; row < 15; row++) {
            for (let col = 0; col < 15; col++) {
                if (!this.board[row][col]) return false;
            }
        }
        return true;
    }

    // 请求悔棋
    requestUndo(socketId) {
        const player = this.players.find(p => p.id === socketId);
        if (!player) return { error: '玩家不存在' };
        
        if (!this.gameRunning) return { error: '游戏未开始' };
        
        // 检查是否已用过悔棋
        if (this.undoUsed[player.color]) {
            return { error: '本局已使用过悔棋机会' };
        }
        
        // 检查是否有自己的落子可以悔棋
        const lastOwnMove = this.findLastOwnMove(socketId);
        if (!lastOwnMove) {
            return { error: '没有可以悔的棋' };
        }
        
        // 发送悔棋请求给对手
        const opponent = this.players.find(p => p.id !== socketId);
        if (opponent && opponent.socket) {
            this.pendingUndo = {
                requesterId: socketId,
                requesterColor: player.color
            };
            
            opponent.socket.emit('undo_request', {
                requesterName: player.username
            });
            
            return { success: true, pending: true };
        }
        
        return { error: '对手不在线' };
    }
    
    // 查找最后一次自己的落子
    findLastOwnMove(socketId) {
        for (let i = this.moveHistory.length - 1; i >= 0; i--) {
            if (this.moveHistory[i].playerId === socketId) {
                return this.moveHistory[i];
            }
        }
        return null;
    }
    
    // 接受悔棋
    acceptUndo(socketId) {
        if (!this.pendingUndo) return { error: '没有待处理的悔棋请求' };
        
        const requester = this.players.find(p => p.id === this.pendingUndo.requesterId);
        if (!requester) {
            this.pendingUndo = null;
            return { error: '请求者不存在' };
        }
        
        // 执行悔棋：撤销最后一步棋
        if (this.moveHistory.length > 0) {
            const lastMove = this.moveHistory.pop();
            this.board[lastMove.row][lastMove.col] = null;
            
            // 标记已使用悔棋
            this.undoUsed[requester.color] = true;
            
            // 切换回合到悔棋的那一方
            this.currentTurn = lastMove.color;
            
            // 广播悔棋成功
            this.broadcast('undo_success', {
                row: lastMove.row,
                col: lastMove.col,
                undoColor: lastMove.color,
                currentTurn: this.currentTurn,
                undoUsed: this.undoUsed
            });
            
            console.log(`[五子棋] 房间 ${this.code}: ${requester.username} 悔棋成功`);
        }
        
        this.pendingUndo = null;
        return { success: true };
    }
    
    // 拒绝悔棋
    rejectUndo(socketId) {
        if (!this.pendingUndo) return { error: '没有待处理的悔棋请求' };
        
        const requester = this.players.find(p => p.id === this.pendingUndo.requesterId);
        if (requester && requester.socket) {
            requester.socket.emit('undo_rejected', {});
        }
        
        this.pendingUndo = null;
        return { success: true };
    }

    restartGame() {
        this.board = Array(15).fill(null).map(() => Array(15).fill(null));
        this.gameRunning = true;
        this.moveHistory = []; // 重置落子历史
        this.undoUsed = { black: false, white: false }; // 重置悔棋次数
        this.pendingUndo = null;
        
        this.players.forEach(p => {
            p.color = p.color === 'black' ? 'white' : 'black';
        });
        
        this.currentTurn = 'black';
        
        const blackPlayer = this.players.find(p => p.color === 'black');
        const whitePlayer = this.players.find(p => p.color === 'white');
        
        this.players.forEach(player => {
            player.socket.emit('game_restarted', {
                yourColor: player.color,
                blackPlayer: blackPlayer.username,
                blackAvatar: blackPlayer.avatar || '',
                whitePlayer: whitePlayer.username,
                whiteAvatar: whitePlayer.avatar || ''
            });
        });
    }

    broadcastRoomUpdate() {
        const roomInfo = {
            code: this.code,
            players: this.players.filter(p => !p.offline).map(p => ({
                username: p.username,
                avatar: p.avatar || '',
                color: p.color,
                ready: p.ready
            }))
        };
        this.broadcast('room_updated', roomInfo);
    }

    broadcast(event, data) {
        this.players.forEach(player => {
            if (player.socket) player.socket.emit(event, data);
        });
    }
}

// 五子棋 Socket.IO 命名空间
const gomokuIO = io.of('/gomoku');

gomokuIO.on('connection', (socket) => {
    console.log('[五子棋] 新连接:', socket.id);

    socket.on('create_room', (data) => {
        const { username, avatar } = data;
        let code;
        do {
            code = generateGomokuRoomCode();
        } while (gomokuRooms.has(code));
        
        const room = new GomokuRoom(code, socket.id, username);
        gomokuRooms.set(code, room);
        room.addPlayer(socket, username, avatar);
        
        socket.emit('room_created', { 
            roomCode: code,
            players: room.players.map(p => ({
                username: p.username, avatar: p.avatar || '', color: p.color, ready: p.ready
            }))
        });
    });

    socket.on('join_room', (data) => {
        const { roomCode, username, avatar } = data;
        const code = roomCode.toUpperCase().trim();
        const room = gomokuRooms.get(code);
        
        if (!room) {
            socket.emit('join_error', { message: '房间不存在' });
            return;
        }
        const hasOfflineSlot = room.players.some(p => p.offline && p.username === username);
        const onlineCount = room.players.filter(p => !p.offline).length;
        if (!hasOfflineSlot && onlineCount >= 2) {
            socket.emit('join_error', { message: '房间已满' });
            return;
        }
        if (!hasOfflineSlot && room.gameRunning) {
            socket.emit('join_error', { message: '游戏已开始' });
            return;
        }
        
        room.addPlayer(socket, username, avatar);
        socket.emit('room_joined', { 
            roomCode: room.code,
            gameRunning: room.gameRunning,
            players: room.players.map(p => ({
                username: p.username, avatar: p.avatar || '', color: p.color, ready: p.ready
            }))
        });
    });

    socket.on('toggle_ready', (data) => {
        const room = gomokuPlayerSockets.get(socket.id);
        if (room) room.setPlayerReady(socket.id, data.ready);
    });

    socket.on('leave_room', () => {
        const room = gomokuPlayerSockets.get(socket.id);
        if (room) room.removePlayer(socket.id);
    });

    socket.on('place_stone', (data) => {
        const room = gomokuPlayerSockets.get(socket.id);
        if (room && room.gameRunning) {
            const result = room.placeStone(socket.id, data.row, data.col);
            if (result.error) {
                socket.emit('action_error', { message: result.error });
            }
        }
    });

    socket.on('play_again', () => {
        const room = gomokuPlayerSockets.get(socket.id);
        if (room && room.players.length === 2) {
            const opponent = room.players.find(p => p.id !== socket.id);
            if (opponent && opponent.socket) {
                opponent.socket.emit('play_again_request', {});
            }
        }
    });

    socket.on('play_again_accept', () => {
        const room = gomokuPlayerSockets.get(socket.id);
        if (room) room.restartGame();
    });

    socket.on('play_again_reject', () => {
        const room = gomokuPlayerSockets.get(socket.id);
        if (room) {
            const requester = room.players.find(p => p.id !== socket.id);
            if (requester && requester.socket) {
                requester.socket.emit('play_again_rejected', {});
            }
        }
    });

    // 请求悔棋
    socket.on('request_undo', () => {
        const room = gomokuPlayerSockets.get(socket.id);
        if (room && room.gameRunning) {
            const result = room.requestUndo(socket.id);
            if (result.error) {
                socket.emit('action_error', { message: result.error });
            } else if (result.pending) {
                socket.emit('undo_pending', { message: '等待对方同意...' });
            }
        }
    });

    // 接受悔棋
    socket.on('accept_undo', () => {
        const room = gomokuPlayerSockets.get(socket.id);
        if (room) {
            room.acceptUndo(socket.id);
        }
    });

    // 拒绝悔棋
    socket.on('reject_undo', () => {
        const room = gomokuPlayerSockets.get(socket.id);
        if (room) {
            room.rejectUndo(socket.id);
        }
    });

    socket.on('chat_message', (data) => {
        if (!data || !data.text) return;
        const room = gomokuPlayerSockets.get(socket.id);
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;
        room.broadcast('chat_message', {
            username: player.username,
            color: player.color,
            text: String(data.text).substring(0, 100),
            timestamp: Date.now()
        });
    });

    socket.on('disconnect', () => {
        console.log('[五子棋] 断开连接:', socket.id);
        const room = gomokuPlayerSockets.get(socket.id);
        if (room) room.removePlayer(socket.id);
    });
});

// 定期清理五子棋空房间
setInterval(() => {
    const now = Date.now();
    for (const [code, room] of gomokuRooms) {
        if (room.players.length === 0 || now - room.createdAt > 3600000) {
            gomokuRooms.delete(code);
            console.log(`[五子棋] 清理过期房间: ${code}`);
        }
    }
}, 60000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🀄 麻将多人服务器运行在端口 ${PORT}`);
    console.log(`⚫ 五子棋多人服务器运行在端口 ${PORT} (命名空间: /gomoku)`);
    console.log(`🌐 打开浏览器访问: http://localhost:${PORT}`);
});

