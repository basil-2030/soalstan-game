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
        "type": "text", "hint": "تنبيه", "q": "خطأ في ملف questions.json، يرجى مراجعته.", "options": ["علم", "جاري التصحيح"], "a": "علم"
    }];
}

let roomsData = {};

// دالة الانتقال التلقائي للسؤال التالي
function startNewRound(rID) {
    const room = roomsData[rID];
    if(!room || questionBank.length === 0) return;

    room.currentRound++;
    if (room.currentRound > room.settings.maxRounds) {
        io.to(rID).emit('gameOver', { pointsA: room.teams['A'].points, pointsB: room.teams['B'].points });
        delete roomsData[rID];
        return;
    }

    const q = questionBank[Math.floor(Math.random() * questionBank.length)];
    room.currentQuestion = q; 
    room.normalAnswers = { 'A': null, 'B': null };
    room.turnTaken = false;
    room.firstTeam = null;
    
    // التحقق هل الجولة الحالية هي جولة المزاد؟
    if (room.currentRound === room.auctionRound) {
        room.mode = 'auction';
        io.to(rID).emit('startAuction', { hint: q.hint, fullQuestion: q, roundNumber: room.currentRound, isChange: false });
    } else {
        room.mode = 'normal';
        io.to(rID).emit('startNormalRound', { fullQuestion: q, roundNumber: room.currentRound, isChange: false });
    }
}

// دالة تقييم الجولة العادية
function evaluateNormalRound(rID, room) {
    let correctAns = room.currentQuestion.a;
    let resA = false, resB = false;

    if (room.normalAnswers['A'] === correctAns) { resA = true; room.teams['A'].points += 50; }
    else if (room.normalAnswers['A'] && room.normalAnswers['A'] !== "TIMEOUT") { room.teams['A'].points -= 30; }

    if (room.normalAnswers['B'] === correctAns) { resB = true; room.teams['B'].points += 50; }
    else if (room.normalAnswers['B'] && room.normalAnswers['B'] !== "TIMEOUT") { room.teams['B'].points -= 30; }

    let isTimeout = (room.normalAnswers['A'] === "TIMEOUT" && room.normalAnswers['B'] === "TIMEOUT");

    io.to(rID).emit('normalRoundResult', {
        ansA: room.normalAnswers['A'], resA: resA,
        ansB: room.normalAnswers['B'], resB: resB,
        correctAns: correctAns,
        isTimeout: isTimeout
    });
    io.to(rID).emit('updateScores', { pointsA: room.teams['A'].points, pointsB: room.teams['B'].points });
    room.currentQuestion = null;

    // انتقال تلقائي إذا كان تايم أوت
    if (isTimeout) {
        setTimeout(() => { if (roomsData[rID]) startNewRound(rID); }, 4000);
    }
}

io.on('connection', (socket) => {
    socket.on('joinRoom', (data) => {
        const { roomID, settings, team, teamAName, teamBName } = data;
        if (!roomID) return;

        // عزل تام للغرف
        if(socket.currentRoom) {
            socket.leave(socket.currentRoom);
        }

        socket.join(roomID);
        socket.currentRoom = roomID;

        if (!roomsData[roomID]) {
            let maxRnds = settings ? settings.maxRounds : 10;
            roomsData[roomID] = {
                teams: { 
                    'A': { points: 100, leader: null, name: teamAName || "فريق A" }, 
                    'B': { points: 100, leader: null, name: teamBName || "فريق B" } 
                },
                settings: settings || { roundTime: 30, maxRounds: maxRnds },
                currentQuestion: null, 
                currentRound: 0,
                auctionRound: Math.floor(Math.random() * maxRnds) + 1, // جولة مزاد عشوائية
                mode: 'none',
                normalAnswers: { 'A': null, 'B': null },
                turnTaken: false,
                firstTeam: null
            };
        }
        
        const room = roomsData[roomID];

        // تعيين القائد لأول شخص يدخل فريقه
        if (team && !room.teams[team].leader) {
            room.teams[team].leader = socket.id;
        }

        const isLeader = (socket.id === room.teams[team].leader);

        socket.emit('init', { 
            pointsA: room.teams['A'].points, 
            pointsB: room.teams['B'].points, 
            teamAName: room.teams['A'].name,
            teamBName: room.teams['B'].name,
            isLeader: isLeader, 
            settings: room.settings 
        });

        io.to(roomID).emit('updateScores', { pointsA: room.teams['A'].points, pointsB: room.teams['B'].points });
    });

    socket.on('requestAuction', () => {
        const rID = socket.currentRoom;
        if (rID && roomsData[rID]) startNewRound(rID);
    });

    socket.on('changeQuestion', () => {
        const rID = socket.currentRoom;
        const room = roomsData[rID];
        if(!room || questionBank.length === 0) return;

        const q = questionBank[Math.floor(Math.random() * questionBank.length)];
        room.currentQuestion = q; 
        room.normalAnswers = { 'A': null, 'B': null };
        room.turnTaken = false;
        room.firstTeam = null;
        
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

        // 💡 معالجة إجابات الجولة العادية (المستقلة)
        if (room.mode === 'normal') {
            if (data.answer === "TIMEOUT_ALL") {
                if (room.normalAnswers['A'] === null) room.normalAnswers['A'] = "TIMEOUT";
                if (room.normalAnswers['B'] === null) room.normalAnswers['B'] = "TIMEOUT";
                evaluateNormalRound(rID, room);
                return;
            }

            if (room.normalAnswers[data.team] !== null) return; // منع التكرار
            room.normalAnswers[data.team] = data.answer;
            io.to(rID).emit('teamAnswered', { team: data.team });

            if (room.normalAnswers['A'] !== null && room.normalAnswers['B'] !== null) {
                evaluateNormalRound(rID, room);
            }

        // 💡 معالجة إجابات جولة المزاد
        } else if (room.mode === 'auction') {
            if (room.turnTaken && data.team === room.firstTeam) return;

            if (data.answer === "TIMEOUT") {
                room.teams[data.team].points -= 30;
                if (!room.turnTaken) {
                    room.turnTaken = true;
                    room.firstTeam = data.team;
                    const wrong = room.currentQuestion.options.filter(o => o !== room.currentQuestion.a);
                    const newOptions = [room.currentQuestion.a, wrong[0], wrong[1]].sort(() => Math.random() - 0.5);
                    io.to(rID).emit('passTurn', { toTeam: data.team === 'A' ? 'B' : 'A', newOptions: newOptions, isTimeout: true });
                } else {
                    let correctAns = room.currentQuestion.a;
                    room.currentQuestion = null;
                    io.to(rID).emit('auctionRoundResult', { isCorrect: false, team: data.team, correctAns: correctAns, isTimeout: true });
                    
                    // انتقال تلقائي للمزاد
                    setTimeout(() => { if (roomsData[rID]) startNewRound(rID); }, 4000);
                }
                io.to(rID).emit('updateScores', { pointsA: room.teams['A'].points, pointsB: room.teams['B'].points });
                return;
            }

            const isCorrect = data.answer === room.currentQuestion.a;
            if (isCorrect) {
                room.teams[data.team].points += 50;
                let correctAns = room.currentQuestion.a;
                room.currentQuestion = null;
                io.to(rID).emit('auctionRoundResult', { isCorrect: true, team: data.team, name: data.name, correctAns: correctAns });
            } else {
                room.teams[data.team].points -= 30;
                if (!room.turnTaken) {
                    room.turnTaken = true;
                    room.firstTeam = data.team;
                    const wrong = room.currentQuestion.options.filter(o => o !== room.currentQuestion.a);
                    const newOptions = [room.currentQuestion.a, wrong[0], wrong[1]].sort(() => Math.random() - 0.5);
                    io.to(rID).emit('passTurn', { toTeam: data.team === 'A' ? 'B' : 'A', newOptions: newOptions });
                } else {
                    let correctAns = room.currentQuestion.a;
                    room.currentQuestion = null;
                    io.to(rID).emit('auctionRoundResult', { isCorrect: false, team: data.team, name: data.name, correctAns: correctAns });
                }
            }
            io.to(rID).emit('updateScores', { pointsA: room.teams['A'].points, pointsB: room.teams['B'].points });
        }
    });

    socket.on('placeBid', (d) => {
        if(socket.currentRoom) io.to(socket.currentRoom).emit('updateBid', d);
    });

    socket.on('winAuction', (d) => {
        if(socket.currentRoom) io.to(socket.currentRoom).emit('revealAuctionQuestion', d);
    });

    socket.on('leaveRoom', () => {
        const rID = socket.currentRoom;
        if(rID) {
            const room = roomsData[rID];
            if (room) {
                if (room.teams['A'].leader === socket.id) room.teams['A'].leader = null;
                if (room.teams['B'].leader === socket.id) room.teams['B'].leader = null;
            }
            socket.leave(rID);
            socket.currentRoom = null;
        }
    });

    socket.on('disconnect', () => {
        const rID = socket.currentRoom;
        if (rID && roomsData[rID]) {
            let room = roomsData[rID];
            if (room.teams['A'].leader === socket.id) room.teams['A'].leader = null;
            if (room.teams['B'].leader === socket.id) room.teams['B'].leader = null;
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('🚀 Server is running!'));












