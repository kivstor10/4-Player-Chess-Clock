const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');
const readline = require('readline');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ============================================
// CONFIGURATION - Edit these values as needed
// ============================================
const TIMER_SECONDS = 15;       // Seconds per turn
const PLAYERS_REQUIRED = 4;     // Players needed to start (2-4)
const CHAT_ENABLED = true;      // Enable whisper chat feature
const TIMER_MS = TIMER_SECONDS * 1000;

// Player order: red -> yellow -> green -> blue -> red...
const PLAYER_ORDER = ['red', 'yellow', 'green', 'blue'];

// Game state
let gameState = {
    players: {
        red: { taken: false, socketId: null, sessionId: null, timeRemaining: TIMER_MS, eliminated: false, disconnected: false },
        yellow: { taken: false, socketId: null, sessionId: null, timeRemaining: TIMER_MS, eliminated: false, disconnected: false },
        green: { taken: false, socketId: null, sessionId: null, timeRemaining: TIMER_MS, eliminated: false, disconnected: false },
        blue: { taken: false, socketId: null, sessionId: null, timeRemaining: TIMER_MS, eliminated: false, disconnected: false }
    },
    activePlayer: null,
    gameStarted: false,
    gameOver: false
};

// Timer interval
let timerInterval = null;
let gamePaused = false;

// Serve static files
app.use(express.static('.'));
const { exec } = require('child_process');

// Get local IP address (prefer WiFi/Ethernet over virtual adapters)
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    let fallbackIP = null;
    
    // Priority order: WiFi, Ethernet, then any other
    const priorityNames = ['wi-fi', 'wifi', 'wireless'];
    const excludeNames = ['virtualbox', 'vmware', 'vbox', 'docker', 'hyper-v', 'loopback'];
    // VirtualBox default range and other common virtual network ranges
    const excludeIPRanges = ['192.168.56.', '192.168.99.', '172.17.', '172.18.'];
    
    for (const name of Object.keys(interfaces)) {
        const nameLower = name.toLowerCase();
        
        // Skip virtual/container adapters by name
        if (excludeNames.some(exclude => nameLower.includes(exclude))) {
            continue;
        }
        
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                // Skip virtual network IP ranges
                if (excludeIPRanges.some(range => iface.address.startsWith(range))) {
                    continue;
                }
                
                // Check if this is a priority adapter (WiFi)
                if (priorityNames.some(priority => nameLower.includes(priority))) {
                    return iface.address;
                }
                // Store as fallback if not a priority adapter
                if (!fallbackIP) {
                    fallbackIP = iface.address;
                }
            }
        }
    }
    
    return fallbackIP || 'localhost';
}

// Reset game state
function resetGame() {
    gameState = {
        players: {
            red: { taken: false, socketId: null, sessionId: null, timeRemaining: TIMER_MS, eliminated: false, disconnected: false },
            yellow: { taken: false, socketId: null, sessionId: null, timeRemaining: TIMER_MS, eliminated: false, disconnected: false },
            green: { taken: false, socketId: null, sessionId: null, timeRemaining: TIMER_MS, eliminated: false, disconnected: false },
            blue: { taken: false, socketId: null, sessionId: null, timeRemaining: TIMER_MS, eliminated: false, disconnected: false }
        },
        activePlayer: null,
        gameStarted: false,
        gameOver: false
    };
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
}

// Start the timer countdown
function startTimer() {
    if (timerInterval) clearInterval(timerInterval);
    
    timerInterval = setInterval(() => {
        if (gameState.activePlayer && !gameState.gameOver && !gamePaused) {
            gameState.players[gameState.activePlayer].timeRemaining -= 100;
            
            // Check if time ran out
            if (gameState.players[gameState.activePlayer].timeRemaining <= 0) {
                gameState.players[gameState.activePlayer].timeRemaining = 0;
                // Player ran out of time - eliminate them
                const timedOutPlayer = gameState.activePlayer;
                gameState.players[timedOutPlayer].eliminated = true;
                io.emit('playerEliminated', {
                    color: timedOutPlayer,
                    players: gameState.players
                });
                moveToNextPlayer();
            }
            
            // Broadcast updated times to all players
            io.emit('timeUpdate', {
                players: gameState.players,
                activePlayer: gameState.activePlayer
            });
        }
    }, 100);
}

// Move to the next player in order
function moveToNextPlayer() {
    if (!gameState.activePlayer) return;

    const currentIndex = PLAYER_ORDER.indexOf(gameState.activePlayer);
    let nextIndex = (currentIndex + 1) % PLAYER_ORDER.length;
    let attempts = 0;

    // Count remaining players
    const remainingPlayers = PLAYER_ORDER.filter(color => gameState.players[color].taken && !gameState.players[color].eliminated);
    if (remainingPlayers.length === 1) {
        // Only one player left, they win immediately
        gameState.gameOver = true;
        io.emit('gameOver', { winner: remainingPlayers[0] });
        return;
    }

    // Find next player that is connected and not eliminated
    while (attempts < PLAYER_ORDER.length) {
        const nextPlayer = PLAYER_ORDER[nextIndex];
        if (gameState.players[nextPlayer].taken && !gameState.players[nextPlayer].eliminated) {
            gameState.activePlayer = nextPlayer;
            // Reset timer for next player
            gameState.players[nextPlayer].timeRemaining = TIMER_MS;
            io.emit('turnChange', {
                activePlayer: gameState.activePlayer,
                players: gameState.players
            });
            return;
        }
        nextIndex = (nextIndex + 1) % PLAYER_ORDER.length;
        attempts++;
    }

    // If no valid next player, game is over
    gameState.gameOver = true;
    io.emit('gameOver', { winner: determineWinner() });
}

// Determine winner (player with most time remaining)
function determineWinner() {
    let winner = null;
    let maxTime = -1;
    
    for (const [color, data] of Object.entries(gameState.players)) {
        if (data.taken && data.timeRemaining > maxTime) {
            maxTime = data.timeRemaining;
            winner = color;
        }
    }
    
    return winner;
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    // Send current game state to new connection
    socket.emit('gameState', {
        players: gameState.players,
        activePlayer: gameState.activePlayer,
        gameStarted: gameState.gameStarted,
        timerSeconds: TIMER_SECONDS,
        playersRequired: PLAYERS_REQUIRED,
        chatEnabled: CHAT_ENABLED
    });
    
    // Handle reconnection by session ID
    socket.on('reconnectSession', (sessionId) => {
        if (!sessionId) return;
        
        // Find if this session was associated with a color
        for (const [color, player] of Object.entries(gameState.players)) {
            if (player.sessionId === sessionId && player.disconnected && !player.eliminated) {
                // Reconnect this player
                player.socketId = socket.id;
                player.disconnected = false;
                socket.color = color;
                socket.sessionId = sessionId;
                
                console.log(`Player reconnected as ${color} via session`);
                
                // Notify all clients
                io.emit('colorSelected', {
                    color: color,
                    players: gameState.players,
                    reconnected: true
                });
                
                // Confirm to the reconnected player
                socket.emit('colorConfirmed', {
                    color: color,
                    reconnected: true,
                    gameState: {
                        players: gameState.players,
                        activePlayer: gameState.activePlayer,
                        gameStarted: gameState.gameStarted,
                        gameOver: gameState.gameOver
                    }
                });
                return;
            }
        }
        
        // Session not found or not reconnectable - client will show color selection
        socket.emit('sessionNotFound');
    });
    
    // Player selects a color
    socket.on('selectColor', (data) => {
        const color = typeof data === 'string' ? data : data.color;
        const sessionId = typeof data === 'object' ? data.sessionId : null;
        
        if (!gameState.players[color]) return;
        
        // Allow selection if slot is free OR if player is reconnecting to a disconnected slot
        const canTake = !gameState.players[color].taken;
        const canReconnect = gameState.players[color].taken && 
                            gameState.players[color].disconnected && 
                            !gameState.players[color].eliminated;
        
        if (canTake || canReconnect) {
            gameState.players[color].taken = true;
            gameState.players[color].socketId = socket.id;
            gameState.players[color].sessionId = sessionId;
            gameState.players[color].disconnected = false;
            socket.color = color;
            socket.sessionId = sessionId;
            
            const action = canReconnect ? 'reconnected as' : 'selected';
            console.log(`Player ${action} ${color}`);
            
            // Broadcast updated state to all
            io.emit('colorSelected', {
                color: color,
                players: gameState.players,
                reconnected: canReconnect
            });
            
            // Confirm selection to the player (include reconnection info)
            socket.emit('colorConfirmed', { 
                color: color,
                reconnected: canReconnect,
                gameState: {
                    players: gameState.players,
                    activePlayer: gameState.activePlayer,
                    gameStarted: gameState.gameStarted,
                    gameOver: gameState.gameOver
                }
            });
        } else {
            socket.emit('colorError', { message: 'Color already taken' });
        }
    });
    
    // Handle private whisper messages
    socket.on('whisper', (data) => {
        if (!CHAT_ENABLED) return;
        if (!socket.color) return;
        const { to, message, isGif } = data;
        if (!to || !message) return;
        // Restrict whisper chat to only colors that are taken (selected by a player)
        if (!gameState.players[to] || !gameState.players[to].taken) {
            socket.emit('error', { message: 'You can only whisper to players who have selected a color.' });
            return;
        }
        // Optionally, restrict sender as well (already checked above)
        // Send whisper only to valid recipient
        const recipientSocketId = gameState.players[to].socketId;
        if (recipientSocketId) {
            io.to(recipientSocketId).emit('whisper', {
                from: socket.color,
                message: isGif ? message.substring(0, 500) : message.substring(0, 200),
                isGif: isGif || false
            });
        }
    });

    // Typing indicator event
    // Typing indicator logic removed
    
    // Player taps to end their turn (pass to next player)
    socket.on('endTurn', () => {
        if (!socket.color) return;
        
        // If game hasn't started, only first player in order can start
        if (!gameState.gameStarted) {
            // Check if enough players are connected
            const connectedPlayers = Object.values(gameState.players).filter(p => p.taken).length;
            if (connectedPlayers < PLAYERS_REQUIRED) {
                socket.emit('error', { message: `Need ${PLAYERS_REQUIRED} players to start` });
                return;
            }
            
            // Find who should start (first connected player in order)
            let firstPlayer = null;
            for (const color of PLAYER_ORDER) {
                if (gameState.players[color].taken) {
                    firstPlayer = color;
                    break;
                }
            }
            
            // Only first player can start the game
            if (socket.color !== firstPlayer) {
                return;
            }
            
            gameState.gameStarted = true;
            gameState.activePlayer = firstPlayer;
            // Reset timer for first player
            gameState.players[firstPlayer].timeRemaining = TIMER_MS;
            
            startTimer();
            io.emit('gameStarted', {
                activePlayer: gameState.activePlayer,
                players: gameState.players
            });
            return;
        }
        
        // Only active player can end their turn
        if (socket.color === gameState.activePlayer && !gameState.gameOver) {
            moveToNextPlayer();
        }
    });
    
    // Handle player checkmate (elimination)
    socket.on('checkmated', () => {
        if (!socket.color || gameState.gameOver) return;
        // Allow elimination before game starts
        console.log(`${socket.color} has been checkmated`);
        gameState.players[socket.color].eliminated = true;
        // Count remaining active players
        const activePlayers = Object.entries(gameState.players)
            .filter(([color, data]) => data.taken && !data.eliminated);
        if (gameState.gameStarted) {
            if (activePlayers.length <= 1) {
                // Game over - one player left wins
                gameState.gameOver = true;
                const winner = activePlayers.length === 1 ? activePlayers[0][0] : null;
                io.emit('gameOver', { winner });
                return;
            }
            // If the eliminated player was active, move to next
            if (gameState.activePlayer === socket.color) {
                moveToNextPlayer();
            }
        }
        io.emit('playerEliminated', {
            color: socket.color,
            players: gameState.players
        });
    });
    
    // Handle disconnection
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        if (socket.color && gameState.players[socket.color]) {
            // If game has started, keep the slot reserved for reconnection
            if (gameState.gameStarted && !gameState.gameOver) {
                gameState.players[socket.color].disconnected = true;
                gameState.players[socket.color].socketId = null;
                // Timer continues to run for disconnected player
                console.log(`${socket.color} disconnected but slot reserved for reconnection`);
                
                io.emit('playerDisconnected', {
                    color: socket.color,
                    players: gameState.players,
                    canReconnect: true
                });
            } else {
                // Game not started - free the slot
                gameState.players[socket.color].taken = false;
                gameState.players[socket.color].socketId = null;
                gameState.players[socket.color].disconnected = false;
                
                io.emit('playerDisconnected', {
                    color: socket.color,
                    players: gameState.players,
                    canReconnect: false
                });
            }
        }
        
        // Check if all players disconnected (only truly disconnected, not just away)
        const activelyConnected = Object.values(gameState.players).filter(p => p.taken && !p.disconnected).length;
        if (activelyConnected === 0) {
            resetGame();
            console.log('All players disconnected. Game reset.');
        }
    });
    
    // Admin reset
    socket.on('resetGame', () => {
        resetGame();
        io.emit('gameReset');
        console.log('Game has been reset');
    });
});

const PORT = 80;

server.listen(PORT, '0.0.0.0', () => {
    const localIP = getLocalIP();
    console.log('\n=================================');
    console.log('  4-Player Chess Timer Server');
    console.log('=================================');
    console.log(`Timer set to: ${TIMER_SECONDS} seconds (${Math.floor(TIMER_SECONDS/60)}:${(TIMER_SECONDS%60).toString().padStart(2,'0')})`);
    console.log(`Players required: ${PLAYERS_REQUIRED}`);
    console.log(`\nServer running on:`);
    console.log(`  Local:   http://localhost`);
    console.log(`  Network: http://${localIP}`);
    console.log('\nPress Ctrl+C to stop the server.');
    console.log(`\nPress ENTER to pause/resume game`);
    console.log(`Type 'R' to reset/stop game and return to menu`);
    console.log('=================================\n');
    
    // Console input for pause/resume/stop
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    
    rl.on('line', (input) => {
        const cmd = input.trim().toLowerCase();
        
        if (cmd === 'r') {
            // Reset/stop game and return all players to menu
            resetGame();
            gamePaused = false;
            io.emit('gameReset');
            console.log('\nGame RESET/STOPEED - All players returned to menu');
        } else {
            // Toggle pause/resume on Enter
            if (!gamePaused) {
                gamePaused = true;
                io.emit('gamePaused', true);
                console.log('\nGame PAUSED - Press ENTER to resume');
            } else {
                gamePaused = false;
                io.emit('gamePaused', false);
                console.log('\nGame RESUMED - Press ENTER to pause');
            }
        }
    });
});
