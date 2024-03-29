const request = require('request-promise');
const cheerio = require('cheerio');
const table = require('markdown-table');
const MongoClient = require('mongodb').MongoClient;

const Discord = require('discord.js');
const client = new Discord.Client();

const requiredRole = 'Guild Member';
const channelName = 'item-requests';
const lookupString = 'Source: ';
const adminRole = 'Admin';
const maxRequestsPerPost = 15;
const maxRequestsPerPlayer = 3;
const requestMaxExemptions = ['198991804995993609'];

const classes = ['Warrior', 'Paladin', 'Shaman', 'Mage', 'Rogue', 'Warlock', 'Druid', 'Priest', 'Hunter'];

client.once('ready', () => {
	console.log('Discord is ready!');
});

client.on("error", e => {
    console.log(e)
});

process.on("uncaughtException", e => {
    console.log(e);
});

client.login(process.env.BOT_TOKEN);

const dbClient = new MongoClient(`mongodb+srv://${process.env.MONGO_NAME}:${process.env.MONGO_PASS}@cluster0-xobwb.mongodb.net/test?retryWrites=true&w=majority`, { useNewUrlParser: true, useUnifiedTopology: true });

let requestCollection = null;
let dungeonPosts = null;
dbClient.connect(() => {
    requestCollection = dbClient.db('item-request-bot').collection('item-requests');
    dungeonPosts = dbClient.db('item-request-bot').collection('dungeon-posts');
    console.log('Mongo is ready!');
});



client.on('message', async message => {
    if (message.content.toLowerCase().startsWith('!itemrequesthelp') || message.content.toLowerCase() === '!itemrequest') {
        message.channel.send('In order to request an item, please enter\n```\n!itemrequest <item_name>\n```\nExample\n```\n!itemrequest Ban\'thok Sash\n```\nIf you would like to remove a request (you got the item) just enter the same command again.');
    } else if (message.content.toLowerCase().startsWith('!wiperequests ')) {
        if (!message.member.roles.find(r => r.name === adminRole)) {
            message.channel.send(`${message.member.displayName} is not an Admin`);
            return;
        }
        const userToWipe = message.content.slice('!wiperequests '.length);
        if (isNaN(userToWipe)) {
            message.channel.send('Please submit the user ID of the user you wish to wipe');
            return;
        }
        const server = message.guild;
        const distinctDungeons = await requestCollection.distinct('dungeon', {server:server.id, userId: userToWipe});
        if (!distinctDungeons) {
            message.channel.send(`No item requests found for user ID ${userToWipe}`);
            return;
        }
        await requestCollection.deleteMany({server: server.id, userId: userToWipe});
        distinctDungeons.forEach(async dungeon => {
            await updateDungeonPost(server, dungeon, requestCollection);
        });
        message.channel.send(`Removing all requests made by user ID ${userToWipe}`);
    } else if (message.content.toLowerCase().startsWith('!itemrequest ')) {
        const nickname = message.member.displayName;
        const userId = message.author.id;
        if (!message.member.roles.find(r => r.name === requiredRole)) {
            message.channel.send(`${nickname} does not have role ${requiredRole}`);
            return;
        }
        const classRole = message.member.roles.find(r => classes.includes(r.name));
        if (!classRole) {
            message.channel.send(`${nickname} does not have a class role`);
            return;
        }
        const className = classRole.name;
        const item = message.content.slice('!itemRequest '.length);
        const result = await itemLookup(item)
        if (typeof result === 'string') {
            message.channel.send(result);
        } else {
            // Server info
            const server = message.guild;
            const requestId = `${server.id}.${userId}.${result.item}`;
            const duplicate = await requestCollection.findOne({_id: requestId});
            if (duplicate) {
                await requestCollection.deleteOne({_id: requestId});
            } else {
                const posts = await requestCollection.find({userId: userId, server: server.id}).count();
                if (!requestMaxExemptions.includes(userId) && posts >= maxRequestsPerPlayer) {
                    message.channel.send(`You cannot have more than ${maxRequestsPerPlayer} requests. You currently have ${posts}.`);
                    return;
                }
                await requestCollection.insertOne({_id: requestId, userId: userId, server: server.id, nickname: nickname, className: className, item: result.item, boss: result.boss, dungeon: result.dungeon, date: Date.now()});
            }
            await updateDungeonPost(server, result.dungeon, requestCollection);
            if (duplicate) {
                message.channel.send(`Removing item request for ${result.item} by ${nickname}`);
            } else {
                message.channel.send(`${nickname} - ${className} has requested ${result.item} dropped${result.boss && ` by ${result.boss}`} in ${result.dungeon}`);
            }
        }
    }
});

async function updateDungeonPost(server, dungeon, requestCollection) {
    const dungeonPostKey = `${server.id}.${dungeon}`;
    const channel = server.channels.find('name', channelName);
    if (!channel) {
        return;
    }
    let dungeonPostId = await dungeonPosts.findOne({_id: dungeonPostKey});
    const newMessage = !dungeonPostId;
    const dungeonCursor = await requestCollection.find({server: server.id, dungeon: dungeon}).sort({date: 1});
    let requestString = `^\n__**${dungeon}**__\n`;
    requestString += '```\n';
    const dataTable = [['Player', 'Class', 'Boss', 'Item', 'User ID']];
    let i = 0;
    await dungeonCursor.forEach((itemRequest) => {
        if (i < maxRequestsPerPost) {
            dataTable.push([itemRequest.nickname, itemRequest.className, itemRequest.boss, itemRequest.item, itemRequest.userId]);
        }
        i++;
    });
    requestString += table(dataTable);
    requestString += '```';
    if (!newMessage) {
        const message = await channel.fetchMessage(dungeonPostId.postId);  
        if (!dungeonCursor || await dungeonCursor.count() === 0) {
            message.delete();
            await dungeonPosts.deleteOne({_id: dungeonPostKey});
            return;
        }
        message.edit(requestString);
    } else {
        message = await channel.send(requestString);
        await dungeonPosts.insertOne({_id: dungeonPostKey, postId: message.id});
    }
}

async function itemLookup(item) {
    let result = "";
    if (isNaN(item)) {
        result = await request({uri: `https://itemization.info/?search=${item}`, family: 4});
    } else {
        result = await request({uri: `https://itemization.info/item/${item}`, family: 4});
    }
    const $ = cheerio.load(result);
    if ($('#results').length || $('body').text() === "Not found!") {
        return `Could not find item ${item}`;
    }
    const sourceText = $('#tooltip').first().find(`span:contains("${lookupString}")`).text();
    if (!sourceText) {
        return "ERROR: Could not find source";
    }
    const source = sourceText.slice(lookupString.length);
    let dungeon = source;
    let boss = '';
    if (source.includes('(')) {
        dungeon = source.slice(source.indexOf('(') + 1, source.length - 1);
        boss = source.slice(0, source.indexOf('(') - 1);
    }
    if (source === 'Burning Felguard') { // This one is fucked up
        dungeon = 'Blackrock Spire';
        boss = source;
    }
    dungeon = direMaulLookup(dungeon, boss);
    dungeon = spireLookup(dungeon, boss);
    dungeon = stratLookup(dungeon, boss);
    const name = $('#tooltip').first().find('.name').text();
    if (!name) {
        return 'ERROR: Could not find name';
    }

    return {item: name, dungeon: dungeon, boss: boss};
}

const dmBosses = {
    'Zevrim Thornhoof': 'East',
    'Hydrospawn': 'East',
    'Lethtendris': 'East',
    'Alzzin the Wildshaper': 'East',

    'Tendris Warpwood': 'West',
    'Illyanna Ravenoak': 'West',
    'Magister Kalendris': 'West',
    'Tsu\'zee': 'West',
    'Immol\'thar': 'West',
    'Prince Tortheldrin': 'West',

    'Guard Mol\'dar': 'North',
    'Stomper Kreeg': 'North',
    'Guard Fengus': 'North',
    'Guard Slip\'kik': 'North',
    'Captain Kromcrush': 'North',
    'Cho\'Rush the Observer': 'North',
    'King Gordok': 'North',
    'Gordok Tribute': 'North'
};

function direMaulLookup(dungeon, boss) {
    if (dungeon !== 'Dire Maul') {
        return dungeon;
    }
    if (boss === 'Quest') {
        return 'Dire Maul - Quest';
    }
    let section = dmBosses[boss];
    if (!section) {
        section = 'North'; // Really lazy way to solve the shared tables between the guards in dm north
    }
    return `Dire Maul - ${section}`;
}

const brsBosses = {
    'Burning Felguard': 'Lower',
    'Spirestone Butcher': 'Lower',
    'Highlord Omokk': 'Lower',
    'Spirestone Battle Lord': 'Lower',
    'Spirestone Lord Magus': 'Lower',
    'Shadow Hunter Vosh\'gajin': 'Lower',
    'War Master Voone': 'Lower',
    'Bannok Grimaxe': 'Lower',
    'Mother Smolderweb': 'Lower',
    'Crystal Fang': 'Lower',
    'Urok Doomhowl': 'Lower',
    'Quartermaster Zigris': 'Lower',
    'Halycon': 'Lower',
    'Grizrul the Slavener': 'Lower',
    'Ghok Bashguud': 'Lower',
    'Overlord Wyrmthalak': 'Lower',

    'Pyroguard Emberseer': 'Upper',
    'Solakar Flamewreath': 'Upper',
    'Jed Runewatcher': 'Upper',
    'Goraluk Anvilcrack': 'Upper',
    'Gyth': 'Upper',
    'Warchief Rend Blackhand': 'Upper',
    'The Beast': 'Upper',
    'General Drakkisath': 'Upper'
}

function spireLookup(dungeon, boss) {
    if (dungeon !== 'Blackrock Spire') {
        return dungeon;
    }
    if (boss === 'Quest') {
        return 'Blackrock Spire - Quest';
    }
    
    const section = brsBosses[boss];
    if (!section) {
        return dungeon;
    }
    return `${section} Blackrock Spire`;
}

const stratBosses = {
    'Skul' : 'Living',
    'Hearthsinger Forresten' : 'Living',
    'The Unforgiven' : 'Living',
    'Timmy the Cruel' : 'Living',
    'Malor the Zealos' : 'Living',
    'Crimson Hammersmith' : 'Living',
    'Cannon Master Willey' : 'Living',
    'Archivist Galford' : 'Living',
    'Balnazzar' : 'Living',

    'Magistrate Barthilas': 'Undead',
    'Stonespine': 'Undead',
    'Baroness Anastari': 'Undead',
    'Black Guard Swordsmith': 'Undead',
    'Nerub\'enkan': 'Undead',
    'Maleki the Pallid': 'Undead',
    'Ramstein the Gorger': 'Undead',
    'Baron Rivendare': 'Undead',
    'Postmaster Malown': 'Undead'
};

function stratLookup(dungeon, boss) {
    if (dungeon !== 'Stratholme') {
        return dungeon;
    }
    if (boss === 'Quest') {
        return 'Stratholme - Quest';
    }

    const section = stratBosses[boss];
    if (!section) {
        return dungeon;
    }
    return `Stratholme ${section}`;
}
