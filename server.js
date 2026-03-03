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

// نظام الحماية
try {
    const data = fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8');
    questionBank = JSON.parse(data);
    console.log(`✅ تم تحميل ${questionBank.length} سؤال بنجاح!`);
} catch (e) {
    console.error("🚨 خطأ في ملف الأسئلة: ", e.message); 
    questionBank = [{
        "type": "text", "hint": "تنبيه للقائد", "q": "يوجد خطأ في ملف الأسئلة، يرجى مراجعته.", "options": ["علم", "جاري التصحيح", "حسناً", "تم"], "a": "علم"
    }];
}

let roomsData = {};

io.on('connection', (socket) => {
    socket.on('joinRoom', (data) => {
        const { roomID, settings, team, teamAName, teamBName } = data;
        
        // 🚀 عزل الغرف بشكل جذري
        if(socket.currentRoom && socket.currentRoom !== roomID) {
            socket.leave(socket.currentRoom);
        }

        socket.join(roomID);
        socket.currentRoom = roomID;

        // إعداد الغرفة لأول مرة
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
                // 💡 التعديل الثاني: اختيار جولة مزاد واحدة عشوائياً
                auctionRound: Math.floor(Math.random() * maxRnds) + 1, 
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

    // 1. طلب جولة جديدة
    socket.on('requestAuction', () => {
        const rID = socket.currentRoom;
        const room = roomsData[rID];
        if(!room || questionBank.length === 0) return;

        room.currentRound++; // زيادة الجولة هنا فقط
        if (room.currentRound > room.settings.maxRounds) {
            io.to(rID).emit('gameOver', { pointsA: room.teams['A'].points, pointsB: room.teams['B'].points });
            delete roomsData[rID]; // تنظيف الغرفة بعد الانتهاء
            return;
        }

        const q = questionBank[Math.floor(Math.random() * questionBank.length)];
        room.currentQuestion = q; 
        room.turnTaken = false;
        room.firstTeam = null;
        
        // 💡 التعديل الثاني: التحقق هل الجولة الحالية هي جولة المزاد؟
        if (room.currentRound === room.auctionRound) {
            io.to(rID).emit('startAuction', { hint: q.hint, fullQuestion: q, roundNumber: room.currentRound, isChange: false });
        } else {
            // جولة عادية للجميع
            io.to(rID).emit('startNormalRound', { fullQuestion: q, roundNumber: room.currentRound });
        }
    });

    // 2. تغيير السؤال (نفس الجولة بدون زيادة العداد)
    socket.on('changeQuestion', () => {
        const rID = socket.currentRoom;
        const room = roomsData[rID];
        if(!room || questionBank.length === 0) return;

        const q = questionBank[Math.floor(Math.random() * questionBank.length)];
        room.currentQuestion = q; 
        room.turnTaken = false;
        room.firstTeam = null;
        
        if (room.currentRound === room.auctionRound) {
            io.to(rID).emit('startAuction', { hint: q.hint, fullQuestion: q, roundNumber: room.currentRound, isChange: true });
        } else {
            io.to(rID).emit('startNormalRound', { fullQuestion: q, roundNumber: room.currentRound });
        }
    });

    // 3. معالجة الإجابات وانتهاء الوقت
    socket.on('submitAnswer', (data) => {
        const rID = socket.currentRoom;
        const room = roomsData[rID];
        if(!room || !room.currentQuestion) return;
        
        if (room.turnTaken && data.team === room.firstTeam) return;

        // 💡 التعديل الثالث: إذا انتهى الوقت، إرسال إشارة للسؤال التالي تلقائياً
        if (data.answer === "TIMEOUT") {
            const correctAns = room.currentQuestion.a;
            room.currentQuestion = null; // قفل السؤال
            io.to(rID).emit('timeOutAutoNext', { correctAns: correctAns });
            return;
        }

        const isCorrect = data.answer === room.currentQuestion.a;
        if (isCorrect) {
            room.teams[data.team].points += 50;
            const correctAns = room.currentQuestion.a;
            room.currentQuestion = null;
            io.to(rID).emit('roundResult', { isCorrect: true, team: data.team, points: room.teams[data.team].points, name: data.name, correctAns: correctAns });
        } else {
            room.teams[data.team].points -= 30;
            if (!room.turnTaken && room.currentRound === room.auctionRound) {
                // لو كانت جولة مزاد، وأخطأ، تروح للخصم
                room.turnTaken = true;
                room.firstTeam = data.team;
                const wrong = room.currentQuestion.options.filter(o => o !== room.currentQuestion.a);
                const newOptions = [room.currentQuestion.a, wrong[0], wrong[1]].sort(() => Math.random() - 0.5);
                io.to(rID).emit('passTurn', { toTeam: data.team === 'A' ? 'B' : 'A', newOptions, points: room.teams[data.team].points });
            } else {
                // جولة عادية أو الخصم أخطأ بعد المزاد
                const correctAns = room.currentQuestion.a;
                room.currentQuestion = null;
                io.to(rID).emit('roundResult', { isCorrect: false, team: data.team, points: room.teams[data.team].points, name: data.name, correctAns: correctAns });
            }
        }
        io.to(rID).emit('updateScores', { pointsA: room.teams['A'].points, pointsB: room.teams['B'].points });
    });

    socket.on('placeBid', (d) => io.to(socket.currentRoom).emit('updateBid', d));
    socket.on('winAuction', (d) => io.to(socket.currentRoom).emit('revealQuestion', d));
    
    socket.on('leaveRoom', () => {
        if(socket.currentRoom) {
            socket.leave(socket.currentRoom);
            socket.currentRoom = null;
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('🚀 Server running on port ' + PORT));










