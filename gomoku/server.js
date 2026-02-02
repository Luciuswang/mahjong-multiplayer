const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling']
});

// 静态文件服务
app.use(express.static(path.join(__dirname)));

// 房间管理
const gameRooms = new Map();
const playerSockets = new Map();

// 生成6位房间号
function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
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
        this.currentTurn = 'black'; // 黑方先手
        this.createdAt = Date.now();
        
        console.log(`房间 ${code} 已创建，房主: ${hostName}`);
    }

    // 添加玩家
    addPlayer(socket, username) {
        if (this.players.length >= 2) {
            return null;
        }
        
        const player = {
            id: socket.id,
            username: username,
            socket: socket,
            ready: false,
            color: this.players.length === 0 ? 'black' : 'white'
        };
        
        this.players.push(player);
        playerSockets.set(socket.id, this);
        
        console.log(`玩家 ${username} 加入房间 ${this.code}，执${player.color === 'black' ? '黑' : '白'}子`);
        this.broadcastRoomUpdate();
        
        return player;
    }

    // 移除玩家
    removePlayer(socketId) {
        const playerIndex = this.players.findIndex(p => p.id === socketId);
        if (playerIndex !== -1) {
            const player = this.players[playerIndex];
            this.players.splice(playerIndex, 1);
            playerSockets.delete(socketId);
            
            console.log(`玩家 ${player.username} 离开房间 ${this.code}`);
            
            // 通知对手
            if (this.gameRunning) {
                this.broadcast('opponent_left', {});
            }
            
            this.gameRunning = false;
            
            // 重新分配颜色
            if (this.players.length === 1) {
                this.players[0].color = 'black';
                this.players[0].ready = false;
            }
            
            if (this.players.length === 0) {
                gameRooms.delete(this.code);
                console.log(`房间 ${this.code} 已解散`);
            } else {
                this.broadcastRoomUpdate();
            }
        }
    }

    // 设置玩家准备状态
    setPlayerReady(socketId, ready) {
        const player = this.players.find(p => p.id === socketId);
        if (player) {
            player.ready = ready;
            this.broadcastRoomUpdate();
            
            // 检查是否可以开始游戏
            if (this.players.length === 2 && this.players.every(p => p.ready)) {
                this.startGame();
            }
        }
    }

    // 开始游戏
    startGame() {
        this.gameRunning = true;
        this.board = Array(15).fill(null).map(() => Array(15).fill(null));
        this.currentTurn = 'black';
        
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
                whitePlayer: whitePlayer.username
            });
        });
        
        console.log(`房间 ${this.code} 游戏开始！黑方: ${blackPlayer.username}, 白方: ${whitePlayer.username}`);
    }

    // 落子
    placeStone(socketId, row, col) {
        const player = this.players.find(p => p.id === socketId);
        if (!player) return { error: '玩家不存在' };
        
        if (!this.gameRunning) return { error: '游戏未开始' };
        
        if (player.color !== this.currentTurn) {
            return { error: '还没轮到你' };
        }
        
        if (this.board[row][col]) {
            return { error: '这里已经有棋子了' };
        }
        
        // 落子
        this.board[row][col] = player.color;
        
        // 广播落子
        this.broadcast('stone_placed', {
            row, col,
            color: player.color,
            nextColor: player.color === 'black' ? 'white' : 'black'
        });
        
        // 检查胜负
        const winResult = this.checkWin(row, col, player.color);
        if (winResult.win) {
            this.gameRunning = false;
            this.broadcast('game_over', {
                winner: player.color,
                winnerName: player.username,
                winningCells: winResult.cells
            });
            console.log(`房间 ${this.code} 游戏结束，${player.username} (${player.color}) 获胜！`);
            return { success: true, gameOver: true };
        }
        
        // 检查平局
        if (this.isBoardFull()) {
            this.gameRunning = false;
            this.broadcast('game_over', {
                winner: null,
                draw: true
            });
            return { success: true, gameOver: true, draw: true };
        }
        
        // 切换回合
        this.currentTurn = this.currentTurn === 'black' ? 'white' : 'black';
        
        return { success: true };
    }

    // 检查胜负
    checkWin(row, col, color) {
        const directions = [
            [[0, 1], [0, -1]],   // 横
            [[1, 0], [-1, 0]],   // 竖
            [[1, 1], [-1, -1]], // 斜
            [[1, -1], [-1, 1]]  // 反斜
        ];
        
        for (const [dir1, dir2] of directions) {
            let count = 1;
            const cells = [[row, col]];
            
            // 方向1
            let r = row + dir1[0], c = col + dir1[1];
            while (r >= 0 && r < 15 && c >= 0 && c < 15 && this.board[r][c] === color) {
                count++;
                cells.push([r, c]);
                r += dir1[0];
                c += dir1[1];
            }
            
            // 方向2
            r = row + dir2[0];
            c = col + dir2[1];
            while (r >= 0 && r < 15 && c >= 0 && c < 15 && this.board[r][c] === color) {
                count++;
                cells.push([r, c]);
                r += dir2[0];
                c += dir2[1];
            }
            
            if (count >= 5) {
                return { win: true, cells };
            }
        }
        
        return { win: false };
    }

    // 检查棋盘是否满了
    isBoardFull() {
        for (let row = 0; row < 15; row++) {
            for (let col = 0; col < 15; col++) {
                if (!this.board[row][col]) return false;
            }
        }
        return true;
    }

    // 再来一局
    restartGame() {
        this.board = Array(15).fill(null).map(() => Array(15).fill(null));
        this.gameRunning = true;
        
        // 交换颜色
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
                whitePlayer: whitePlayer.username
            });
        });
    }

    // 广播房间更新
    broadcastRoomUpdate() {
        const roomInfo = {
            code: this.code,
            players: this.players.map(p => ({
                username: p.username,
                color: p.color,
                ready: p.ready
            }))
        };
        
        this.broadcast('room_updated', roomInfo);
    }

    // 广播消息
    broadcast(event, data) {
        this.players.forEach(player => {
            if (player.socket) {
                player.socket.emit(event, data);
            }
        });
    }
}

// Socket.IO 事件处理
io.on('connection', (socket) => {
    console.log('新连接:', socket.id);

    // 创建房间
    socket.on('create_room', (data) => {
        const { username } = data;
        let code;
        do {
            code = generateRoomCode();
        } while (gameRooms.has(code));
        
        const room = new GomokuRoom(code, socket.id, username);
        gameRooms.set(code, room);
        
        const player = room.addPlayer(socket, username);
        
        socket.emit('room_created', { 
            roomCode: code,
            players: room.players.map(p => ({
                username: p.username,
                color: p.color,
                ready: p.ready
            }))
        });
    });

    // 加入房间
    socket.on('join_room', (data) => {
        const { roomCode, username } = data;
        const code = roomCode.toUpperCase().trim();
        const room = gameRooms.get(code);
        
        if (!room) {
            socket.emit('join_error', { message: '房间不存在' });
            return;
        }
        
        if (room.players.length >= 2) {
            socket.emit('join_error', { message: '房间已满' });
            return;
        }
        
        if (room.gameRunning) {
            socket.emit('join_error', { message: '游戏已开始' });
            return;
        }
        
        room.addPlayer(socket, username);
        
        socket.emit('room_joined', { 
            roomCode: room.code,
            players: room.players.map(p => ({
                username: p.username,
                color: p.color,
                ready: p.ready
            }))
        });
    });

    // 准备/取消准备
    socket.on('toggle_ready', (data) => {
        const room = playerSockets.get(socket.id);
        if (room) {
            room.setPlayerReady(socket.id, data.ready);
        }
    });

    // 离开房间
    socket.on('leave_room', () => {
        const room = playerSockets.get(socket.id);
        if (room) {
            room.removePlayer(socket.id);
        }
    });

    // 落子
    socket.on('place_stone', (data) => {
        const room = playerSockets.get(socket.id);
        if (room && room.gameRunning) {
            const result = room.placeStone(socket.id, data.row, data.col);
            if (result.error) {
                socket.emit('action_error', { message: result.error });
            }
        }
    });

    // 再来一局请求
    socket.on('play_again', () => {
        const room = playerSockets.get(socket.id);
        if (room && room.players.length === 2) {
            const opponent = room.players.find(p => p.id !== socket.id);
            if (opponent && opponent.socket) {
                opponent.socket.emit('play_again_request', {});
            }
        }
    });

    // 接受再来一局
    socket.on('play_again_accept', () => {
        const room = playerSockets.get(socket.id);
        if (room) {
            room.restartGame();
        }
    });

    // 拒绝再来一局
    socket.on('play_again_reject', () => {
        const room = playerSockets.get(socket.id);
        if (room) {
            const requester = room.players.find(p => p.id !== socket.id);
            if (requester && requester.socket) {
                requester.socket.emit('play_again_rejected', {});
            }
        }
    });

    // 断开连接
    socket.on('disconnect', () => {
        console.log('断开连接:', socket.id);
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
        if (room.players.length === 0 || now - room.createdAt > 3600000) {
            gameRooms.delete(code);
            console.log(`清理过期房间: ${code}`);
        }
    }
}, 60000);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`⚫⚪ 五子棋服务器运行在端口 ${PORT}`);
    console.log(`🌐 打开浏览器访问: http://localhost:${PORT}`);
});
