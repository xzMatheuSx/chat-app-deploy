const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const getUserDetailsFromToken = require('../helpers/getUserDetailsFromToken');
const UserModel = require('../models/UserModel');
const { ConversationModel, MessageModel } = require('../models/ConversationModel');
const getConversation = require('../helpers/getConversation');

const app = express();

/***socket connection */
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: process.env.FRONTEND_URL,
        credentials: true
    }
});

/***
 * socket running at http://localhost:8080/
 */

// Online users set
const onlineUser = new Set();

io.on('connection', async (socket) => {
    console.log("Connect User ", socket.id);

    try {
        const token = socket.handshake.auth.token;

        // Get user details from token
        const user = await getUserDetailsFromToken(token);

        // Check if user and user._id exist before proceeding
        if (user && user._id) {
            socket.join(user._id.toString()); // Create room with user._id
            onlineUser.add(user._id.toString());

            io.emit('onlineUser', Array.from(onlineUser));
        } else {
            console.error('Erro: Detalhes do usuário ou _id estão indefinidos.');
            return; // Stop further execution if user is undefined
        }

        // Event: Load message page
        socket.on('message-page', async (userId) => {
            try {
                console.log('userId', userId);
                const userDetails = await UserModel.findById(userId).select("-password");

                if (!userDetails) {
                    console.error('Usuário não encontrado');
                    return;
                }

                const payload = {
                    _id: userDetails._id,
                    name: userDetails.name,
                    email: userDetails.email,
                    profile_pic: userDetails.profile_pic,
                    online: onlineUser.has(userId)
                };

                socket.emit('message-user', payload);

                // Get previous messages
                const getConversationMessage = await ConversationModel.findOne({
                    "$or": [
                        { sender: user._id, receiver: userId },
                        { sender: userId, receiver: user._id }
                    ]
                }).populate('messages').sort({ updatedAt: -1 });

                socket.emit('message', getConversationMessage?.messages || []);
            } catch (error) {
                console.error('Erro ao processar "message-page":', error);
            }
        });

        // Event: New message
        socket.on('new message', async (data) => {
            try {
                // Check if conversation exists between the two users
                let conversation = await ConversationModel.findOne({
                    "$or": [
                        { sender: data.sender, receiver: data.receiver },
                        { sender: data.receiver, receiver: data.sender }
                    ]
                });

                // Create new conversation if none exists
                if (!conversation) {
                    const createConversation = await ConversationModel({
                        sender: data.sender,
                        receiver: data.receiver
                    });
                    conversation = await createConversation.save();
                }

                // Save new message
                const message = new MessageModel({
                    text: data.text,
                    imageUrl: data.imageUrl,
                    videoUrl: data.videoUrl,
                    msgByUserId: data.msgByUserId,
                });
                const saveMessage = await message.save();

                // Update conversation with the new message
                await ConversationModel.updateOne({ _id: conversation._id }, {
                    "$push": { messages: saveMessage._id }
                });

                // Fetch updated conversation messages
                const getConversationMessage = await ConversationModel.findOne({
                    "$or": [
                        { sender: data.sender, receiver: data.receiver },
                        { sender: data.receiver, receiver: data.sender }
                    ]
                }).populate('messages').sort({ updatedAt: -1 });

                // Emit updated messages to both sender and receiver
                io.to(data.sender).emit('message', getConversationMessage?.messages || []);
                io.to(data.receiver).emit('message', getConversationMessage?.messages || []);

                // Send updated conversation list to both sender and receiver
                const conversationSender = await getConversation(data.sender);
                const conversationReceiver = await getConversation(data.receiver);

                io.to(data.sender).emit('conversation', conversationSender);
                io.to(data.receiver).emit('conversation', conversationReceiver);
            } catch (error) {
                console.error('Erro ao processar "new message":', error);
            }
        });

        // Event: Load sidebar conversations
        socket.on('sidebar', async (currentUserId) => {
            try {
                console.log("Current user", currentUserId);

                const conversation = await getConversation(currentUserId);
                socket.emit('conversation', conversation);
            } catch (error) {
                console.error('Erro ao carregar "sidebar":', error);
            }
        });

        // Event: Mark messages as seen
        socket.on('seen', async (msgByUserId) => {
            try {
                let conversation = await ConversationModel.findOne({
                    "$or": [
                        { sender: user._id, receiver: msgByUserId },
                        { sender: msgByUserId, receiver: user._id }
                    ]
                });

                const conversationMessageId = conversation?.messages || [];

                // Mark messages as seen
                await MessageModel.updateMany(
                    { _id: { "$in": conversationMessageId }, msgByUserId: msgByUserId },
                    { "$set": { seen: true } }
                );

                // Send updated conversation to both users
                const conversationSender = await getConversation(user._id.toString());
                const conversationReceiver = await getConversation(msgByUserId);

                io.to(user._id.toString()).emit('conversation', conversationSender);
                io.to(msgByUserId).emit('conversation', conversationReceiver);
            } catch (error) {
                console.error('Erro ao marcar como "seen":', error);
            }
        });

        // Event: Disconnect user
        socket.on('disconnect', () => {
            if (user && user._id) {
                onlineUser.delete(user._id.toString());
            }
            console.log('Disconnect user ', socket.id);
        });
    } catch (error) {
        console.error('Erro na conexão do socket:', error);
    }
});

module.exports = {
    app,
    server
};
