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
        "type": "text", "hint": "تنبيه", "q": "خطأ في ملف questions.json، يرجى مراجعته.", "options": ["علم", "جاري التصحيح", "حسناً", "تم"], "a": "علم"
    }];
}

let roomsData = {};

io.on('connection', (socket) => {
    socket.on('joinRoom', (data) => {
        const { roomID, settings, team, teamAName, teamBName } = data;
        
        socket.join(roomID);

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
                auctionRound: Math.floor(Math.random() * maxRnds) + 1, // جولة مزاد واحدة عشوائية
                mode: 'none', // 'normal' أو 'auction'
                normalAnswers: { 'A': null, 'B': null }, // لحفظ إجابات الفريقين المستقلة
                turnTaken: false,
                auctionWinner: null
            };
        }
        
        const room = roomsData[roomID];

        // تعيين القائد لو ما فيه قائد
        if (team && !room.teams[team].leader) {
            room.teams[team].leader = socket.id;
        }

        socket.emit('init', { 
            pointsA: room.teams['A'].points, 
            pointsB: room.teams['B'].points, 
            teamAName: room.teams['A'].name,
            teamBName: room.teams['B'].name,
            isLeader: (socket.id === room.teams[team].leader), 
            settings: room.settings 
        });

        io.to(roomID).emit('updateScores', { pointsA: room.teams['A'].points, pointsB: room.teams['B'].points });
    });

    // بدء جولة جديدة
    socket.on('requestAuction', (data) => {
        const rID = data.roomID;
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
        
        if (room.currentRound === room.auctionRound) {
            room.mode = 'auction';
            io.to(rID).emit('startAuction', { hint: q.hint, fullQuestion: q, roundNumber: room.currentRound, isChange: false });
        } else {
            room.mode = 'normal';
            io.to(rID).emit('startNormalRound', { fullQuestion: q, roundNumber: room.currentRound, isChange: false });
        }
    });

    // تغيير السؤال بدون زيادة العداد
    socket.on('changeQuestion', (data) => {
        const rID = data.roomID;
        const room = roomsData[rID];
        if(!room || questionBank.length === 0) return;

        const q = questionBank[Math.floor(Math.random() * questionBank.length)];
        room.currentQuestion = q; 
        room.normalAnswers = { 'A': null, 'B': null };
        room.turnTaken = false;
        
        if (room.mode === 'auction') {
            io.to(rID).emit('startAuction', { hint: q.hint, fullQuestion: q, roundNumber: room.currentRound, isChange: true });
        } else {
            io.to(rID).emit('startNormalRound', { fullQuestion: q, roundNumber: room.currentRound, isChange: true });
        }
    });

    // معالجة الإجابات
    socket.on('submitAnswer', (data) => {
        const rID = data.roomID;
        const room = roomsData[rID];
        if(!room || !room.currentQuestion) return;

        // ---------- نظام الجولة العادية (كل فريق يجاوب لحاله) ----------
        if (room.mode === 'normal') {
            room.normalAnswers[data.team] = data.answer;
            io.to(rID).emit('teamAnswered', { team: data.team });

            // إذا انتهى الوقت، نفرض أن اللي ما جاوب أخذ تايم أوت
            if (data.answer === "TIMEOUT_ALL") {
                if(!room.normalAnswers['A']) room.normalAnswers['A'] = "TIMEOUT";
                if(!room.normalAnswers['B']) room.normalAnswers['B'] = "TIMEOUT";
            }

            // إذا الفريقين جاوبوا (أو انتهى الوقت)
            if (room.normalAnswers['A'] !== null && room.normalAnswers['B'] !== null) {
                let correctAns = room.currentQuestion.a;
                
                // حساب فريق A
                let resA = false;
                if (room.normalAnswers['A'] === correctAns) { resA = true; room.teams['A'].points += 50; }
                else if (room.normalAnswers['A'] !== "TIMEOUT") { room.teams['A'].points -= 30; }

                // حساب فريق B
                let resB = false;
                if (room.normalAnswers['B'] === correctAns) { resB = true; room.teams['B'].points += 50; }
                else if (room.normalAnswers['B'] !== "TIMEOUT") { room.teams['B'].points -= 30; }

                room.currentQuestion = null; // قفل السؤال
                io.to(rID).emit('normalRoundResult', { 
                    ansA: room.normalAnswers['A'], resA: resA, 
                    ansB: room.normalAnswers['B'], resB: resB, 
                    correctAns: correctAns,
                    isTimeout: (data.answer === "TIMEOUT_ALL")
                });
                io.to(rID).emit('updateScores', { pointsA: room.teams['A'].points, pointsB: room.teams['B'].points });
            }
        } 
        // ---------- نظام جولة المزاد ----------
        else if (room.mode === 'auction') {
            if (data.answer === "TIMEOUT") {
                room.teams[data.team].points -= 30;
                if (!room.turnTaken) {
                    room.turnTaken = true;
                    const wrong = room.currentQuestion.options.filter(o => o !== room.currentQuestion.a);
                    const newOptions = [room.currentQuestion.a, wrong[0], wrong[1]].sort(() => Math.random() - 0.5);
                    io.to(rID).emit('passTurn', { toTeam: data.team === 'A' ? 'B' : 'A', newOptions: newOptions, isTimeout: true });
                } else {
                    let correctAns = room.currentQuestion.a;
                    room.currentQuestion = null;
                    io.to(rID).emit('auctionRoundResult', { isCorrect: false, team: data.team, correctAns: correctAns, isTimeout: true });
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

    socket.on('placeBid', (d) => io.to(d.roomID).emit('updateBid', d));
    socket.on('winAuction', (d) => io.to(d.roomID).emit('revealAuctionQuestion', d));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('🚀 Server is running!'));











