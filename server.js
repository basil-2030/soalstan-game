const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs'); 

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname)); 

let questionBank = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));
let roomsData = {};

io.on('connection', (socket) => {
    socket.on('joinRoom', (data) => {
        const { roomID, name, team, settings } = data;
        socket.join(roomID);
        socket.currentRoom = roomID;
        if (!roomsData[roomID]) {
            roomsData[roomID] = {
                teams: { 'أ': { points: 100, leader: socket.id }, 'ب': { points: 100, leader: null } },
                settings: settings || { roundTime: 30, maxRounds: 10 },
                currentQuestion: null,
                turnTaken: false
            };
        } else if (!roomsData[roomID].teams[team].leader) {
            roomsData[roomID].teams[team].leader = socket.id;
        }
        const room = roomsData[roomID];
        socket.emit('init', { pointsA: room.teams['أ'].points, pointsB: room.teams['ب'].points, isLeader: socket.id === room.teams[team].leader, settings: room.settings });
    });

    socket.on('requestAuction', () => {
        const room = roomsData[socket.currentRoom];
        const q = questionBank[Math.floor(Math.random() * questionBank.length)];
        room.currentQuestion = q;
        room.turnTaken = false;
        io.to(socket.currentRoom).emit('startAuction', { hint: q.hint, fullQuestion: q });
    });

    socket.on('submitAnswer', (data) => {
        const room = roomsData[socket.currentRoom];
        const isCorrect = data.answer === room.currentQuestion.a;
        if (isCorrect) {
            room.teams[data.team].points += 50;
            io.to(socket.currentRoom).emit('roundResult', { isCorrect: true, team: data.team, points: room.teams[data.team].points, name: data.name, correctAns: room.currentQuestion.a });
        } else {
            room.teams[data.team].points -= 30;
            if (!room.turnTaken) {
                room.turnTaken = true;
                const wrongOptions = room.currentQuestion.options.filter(o => o !== room.currentQuestion.a);
                const newOptions = [room.currentQuestion.a, wrongOptions[0], wrongOptions[1]].sort(() => Math.random() - 0.5);
                io.to(socket.currentRoom).emit('passTurn', { toTeam: data.team === 'أ' ? 'ب' : 'أ', newOptions: newOptions, points: room.teams[data.team].points });
            } else {
                io.to(socket.currentRoom).emit('roundResult', { isCorrect: false, team: data.team, points: room.teams[data.team].points, name: data.name, correctAns: room.currentQuestion.a });
            }
        }
    });

    socket.on('winAuction', (d) => io.to(socket.currentRoom).emit('revealQuestion', d));
    socket.on('placeBid', (d) => io.to(socket.currentRoom).emit('updateBid', d));
});
server.listen(process.env.PORT || 3000);






