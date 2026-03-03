const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname)); 

let questionBank = [];

try {
    const data = fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8');
    questionBank = JSON.parse(data);
    console.log(`✅ تم تحميل ${questionBank.length} سؤال بنجاح!`);
} catch (e) {
    console.error("🚨 خطأ في ملف الأسئلة: ", e.message); 
    questionBank = [{
        "type": "text", "hint": "تنبيه", "q": "يوجد خطأ في ملف الأسئلة.", "options": ["علم", "جاري التصحيح", "حسناً", "تم"], "a": "علم"
    }];
}

let roomsData = {};

// دالة الانتقال التلقائي
function startNewRound(rID) {
    const room = roomsData[rID];
    if(!room || questionBank.length === 0) return;

    room.currentRound++;
    if (room.currentRound > room.settings.maxRounds) {
        io.to(rID).emit('gameOver', { players: room.players });
        delete roomsData[rID];
        return;
    }

    const q = questionBank[Math.floor(Math.random() * questionBank.length)];
    room.currentQuestion = q; 
    room.answers = {};
    room.turnTaken = false;
    room.auctionWinner = null;
    
    if (room.currentRound === room.auctionRound) {
        room.mode = 'auction';
        io.to(rID).emit('startAuction', { hint: q.hint, fullQuestion: q, roundNumber: room.currentRound, isChange: false });
    } else {
        room.mode = 'normal';
        io.to(rID).emit('startNormalRound', { fullQuestion: q, roundNumber: room.currentRound, isChange: false });
    }
}

// دالة تقييم الجولة العادية لجميع اللاعبين
function evaluateNormalRound(rID, room) {
    let correctAns = room.currentQuestion.a;
    let results = {};
    let allTimeout = true;

    for (let pid in room.players) {
        let ans = room.answers[pid];
        let res = false;
        
        if (ans === correctAns) {
            res = true;
            room.players[pid].points += 50;
            allTimeout = false;
        } else if (ans && ans !== "TIMEOUT") {
            room.players[pid].points -= 30;
            allTimeout = false;
        }
        
        results[pid] = { name: room.players[pid].name, isCorrect: res, ans: ans };
    }

    io.to(rID).emit('normalRoundResult', { results: results, correctAns: correctAns, isTimeout: allTimeout });
    io.to(rID).emit('updateState', { players: room.players, leader: room.leader });
    room.currentQuestion = null;

    if (allTimeout) {
        setTimeout(() => { if (roomsData[rID]) startNewRound(rID); }, 4000);
    }
}

io.on('connection', (socket) => {
    
    // الانضمام للغرفة بنظام فردي
    socket.on('joinRoom', (data) => {
        const { roomID, name, settings } = data;
        if (!roomID) return;

        if(socket.currentRoom) socket.leave(socket.currentRoom);
        socket.join(roomID);
        socket.currentRoom = roomID;

        if (!roomsData[roomID]) {
            let maxRnds = settings ? settings.maxRounds : 10;
            roomsData[roomID] = {
                players: {}, 
                leader: socket.id,
                settings: settings || { roundTime: 30, maxRounds: maxRnds },
                currentQuestion: null, 
                currentRound: 0,
                auctionRound: Math.floor(Math.random() * maxRnds) + 1,
                mode: 'none',
                answers: {},
                turnTaken: false,
                auctionWinner: null
            };
        }
        
        const room = roomsData[roomID];
        if (!room.leader || !room.players[room.leader]) {
            room.leader = socket.id;
        }

        room.players[socket.id] = { name: name || 'لاعب', points: 100 };

        io.to(roomID).emit('updateState', { players: room.players, leader: room.leader, settings: room.settings });
    });

    socket.on('requestAuction', () => {
        const rID = socket.currentRoom;
        if (rID && roomsData[rID] && roomsData[rID].leader === socket.id) startNewRound(rID);
    });

    socket.on('changeQuestion', () => {
        const rID = socket.currentRoom;
        const room = roomsData[rID];
        if(!room || questionBank.length === 0) return;

        const q = questionBank[Math.floor(Math.random() * questionBank.length)];
        room.currentQuestion = q; 
        room.answers = {};
        room.turnTaken = false;
        
        if (room.mode === 'auction') {
            io.to(rID).emit('startAuction', { hint: q.hint, fullQuestion: q, roundNumber: room.currentRound, isChange: true });
        } else {
            io.to(rID).emit('startNormalRound', { fullQuestion: q, roundNumber: room.currentRound, isChange: true });
        }
    });

    socket.on('submitAnswer', (data) => {
        const rID = socket.currentRoom;
        if (!rID) return;
        const room = roomsData[rID];
        if(!room || !room.currentQuestion) return;

        // ---------- الجولات العادية ----------
        if (room.mode === 'normal') {
            if (data.answer === "TIMEOUT_ALL") {
                for(let pid in room.players) {
                    if (!room.answers[pid]) room.answers[pid] = "TIMEOUT";
                }
                evaluateNormalRound(rID, room);
                return;
            }

            if (room.answers[socket.id]) return; 
            room.answers[socket.id] = data.answer;
            io.to(rID).emit('playerAnswered', { id: socket.id, name: room.players[socket.id].name });

            if (Object.keys(room.answers).length === Object.keys(room.players).length) {
                evaluateNormalRound(rID, room);
            }

        // ---------- جولة المزاد ----------
        } else if (room.mode === 'auction' || room.mode === 'auction_pass') {
            if (data.answer === "TIMEOUT") {
                room.players[socket.id].points -= 30;
                
                if (!room.turnTaken && Object.keys(room.players).length > 1) {
                    room.turnTaken = true;
                    room.mode = 'auction_pass'; 
                    room.answers = {}; 
                    
                    const wrong = room.currentQuestion.options.filter(o => o !== room.currentQuestion.a);
                    const newOptions = [room.currentQuestion.a, wrong[0], wrong[1]].sort(() => Math.random() - 0.5);
                    io.to(rID).emit('passTurn', { excludedId: socket.id, newOptions: newOptions, isTimeout: true });
                } else {
                    let correctAns = room.currentQuestion.a;
                    room.currentQuestion = null;
                    io.to(rID).emit('auctionRoundResult', { isCorrect: false, name: room.players[socket.id].name, correctAns: correctAns, isTimeout: true });
                    setTimeout(() => { if (roomsData[rID]) startNewRound(rID); }, 4000);
                }
                io.to(rID).emit('updateState', { players: room.players, leader: room.leader });
                return;
            }

            const isCorrect = data.answer === room.currentQuestion.a;
            if (isCorrect) {
                room.players[socket.id].points += 50;
                let correctAns = room.currentQuestion.a;
                room.currentQuestion = null;
                io.to(rID).emit('auctionRoundResult', { isCorrect: true, name: room.players[socket.id].name, correctAns: correctAns });
            } else {
                room.players[socket.id].points -= 30;
                if (!room.turnTaken && Object.keys(room.players).length > 1) {
                    room.turnTaken = true;
                    room.mode = 'auction_pass';
                    room.answers = {};
                    
                    const wrong = room.currentQuestion.options.filter(o => o !== room.currentQuestion.a);
                    const newOptions = [room.currentQuestion.a, wrong[0], wrong[1]].sort(() => Math.random() - 0.5);
                    io.to(rID).emit('passTurn', { excludedId: socket.id, newOptions: newOptions });
                } else {
                    let correctAns = room.currentQuestion.a;
                    room.currentQuestion = null;
                    io.to(rID).emit('auctionRoundResult', { isCorrect: false, name: room.players[socket.id].name, correctAns: correctAns });
                }
            }
            io.to(rID).emit('updateState', { players: room.players, leader: room.leader });
        }
    });

    socket.on('placeBid', (d) => { if(socket.currentRoom) io.to(socket.currentRoom).emit('updateBid', d); });
    socket.on('winAuction', (d) => { if(socket.currentRoom) io.to(socket.currentRoom).emit('revealAuctionQuestion', d); });

    function handleLeave(sock) {
        const rID = sock.currentRoom;
        if(rID && roomsData[rID]) {
            delete roomsData[rID].players[sock.id];
            let remainingPlayers = Object.keys(roomsData[rID].players);
            
            if(remainingPlayers.length === 0) {
                delete roomsData[rID];
            } else {
                if(roomsData[rID].leader === sock.id) {
                    roomsData[rID].leader = remainingPlayers[0];
                }
                io.to(rID).emit('updateState', { players: roomsData[rID].players, leader: roomsData[rID].leader });
            }
            sock.leave(rID);
            sock.currentRoom = null;
        }
    }

    socket.on('leaveRoom', () => handleLeave(socket));
    socket.on('disconnect', () => handleLeave(socket));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('🚀 Server is running!'));













