var fs = require('fs')
  , vm = require('vm')
  , irc = require('irc')
  , async = require('async')
  , RegexBuilder = require('./regexBuilder')
  , Knex = require('knex')
  , express = require('express')
  , app = express()
  , exec = require('child_process').exec
  , log4js = require('log4js');

log4js.loadAppender('file');
log4js.addAppender(log4js.appenders.file('app.log'), 'main');
log4js.addAppender(log4js.appenders.file('usage.log'), 'usage');

var sysLog = log4js.getLogger('main');
var usageLog = log4js.getLogger('usage');

try {
	var ircConfig = JSON.parse(fs.readFileSync('config/irc.json'));
} catch (e) {
	sysLog.fatal(e);
	throw e;
}

var client = new irc.Client(ircConfig.server, ircConfig.nick, {
	channels: ircConfig.channels,
	debug: true
});

try {
	var mysqlInfo = JSON.parse(fs.readFileSync('config/mysql.json'));
} catch (e) {
	sysLog.fatal(e);
	throw e;
}
var knex = Knex.Initialize({
	client: 'mysql',
	connection: {
		host: mysqlInfo.host,
		user: mysqlInfo.user,
		password: mysqlInfo.pass,
		database: mysqlInfo.db,
		charset: 'utf8'
	}
});

app.listen(7937);
app.set('view engine', 'jade');
app.use(express.favicon());
app.use(express.logger('dev'));
app.use(express.bodyParser());
app.use(express.methodOverride());
app.use(app.router);

var Modules = [];
var Joins = [];

var BotData = {};

Array.prototype.remove = function() {
	var what, a = arguments, L = a.length, ax;
	while(L && this.length) {
		what = a[--L];
		while((ax = this.indexOf(what)) !== -1) {
			this.splice(ax, 1);
		}
	}

	return this;
};

var BotFunctions = {
	ConfigHandler: {
		GetConfig: function(ConfigName) {
			var config;
			try {
				config = JSON.parse(fs.readFileSync('config/' + ConfigName.toLowerCase() + '.json'));
			} catch (e) {
				sysLog.warn('Error loading config for ' + ConfigName + ', ignoring file');
				config = {};
			}

			return config;
		},
		SaveConfig: function(ConfigName, Data) {
			return fs.writeFileSync('config/' + ConfigName.toLowerCase() + '.json', JSON.stringify(Data, undefined, '\t'));
		}
	},
	Global: {
		GetAllData: function() {
			return BotData;
		},
		GetAllModules: function() {
			return Modules;
		},
		ReloadModules: function() {
			LoadModules();
		},
		exec: function(command, callback) {
			exec(command, callback);
		},
		GetNickServ: function(nick, callback) {
			client.whois(nick, function(whois) {
				callback(whois.account);
			});
		},
		LoadAllData: function() {
			return BotData = BotFunctions.ConfigHandler.GetConfig('all');
		},
		SaveAllData: function() {
			return BotFunctions.ConfigHandler.SaveConfig('all', BotData);
		}
	},
	Admins: {
		Is: function(Nick, callback) {
			client.whois(Nick, function(whois) {
				if(BotData.Admins[whois.account] === true) {
					callback(true);
				} else {
					callback(false);
				}
			});
		},
		Add: function(Nick) {
			return BotData.Admins[Nick] = true;
		},
		Remove: function(Nick) {
			return delete BotData.Admins[Nick];
		},
		Save: function() {
			return BotFunctions.ConfigHandler.SaveConfig('admin', BotData.Admins);
		},
		Load: function() {
			return BotData.Admins = BotFunctions.ConfigHandler.GetConfig('admin');
		}
	},
	Banned: {
		Is: function(Nick) {
			return BotData.Banned[Nick] === true;
		},
		Add: function(Nick) {
			return BotData.Banned[Nick] = true;
		},
		Remove: function(Nick) {
			return delete BotData.Banned[Nick];
		},
		Save: function() {
			return BotFunctions.ConfigHandler.SaveConfig('banned', BotData.Banned);
		},
		Load: function() {
			return BotData.Banned = BotFunctions.ConfigHandler.GetConfig('banned');
		}
	},
	Channels: {
		Add: function(Channel) {
			client.join(Channel);
			BotData.Channels.push(Channel);
		},
		Remove: function(Channel) {
			client.part(Channel);
			BotData.Channels.remove(Channel);
		},
		Save: function() {
			return BotFunctions.ConfigHandler.SaveConfig('channel', BotData.Channels);
		},
		Load: function() {
			return BotData.Channels = BotFunctions.ConfigHandler.GetConfig('channel');
		},
		JoinLoaded: function() {
			for(var i = 0; i < BotData.Channels.length; i++) {
				client.join(BotData.Channels[i]);
			}
		}
	},
	SQL: knex,
	Groups: {
		GetChannels: function(GroupName) {
			return BotData.Groups[GroupName];
		},
		ClearChannels: function(GroupName) {
			return BotData.Groups[GroupName].length = 0;
		},
		RemoveChannel: function(GroupName, ChannelName) {
			return BotData.Groups[GroupName].remove(ChannelName);
		},
		AddChannel: function(GroupName, ChannelName) {
			if(BotData.Groups[GroupName] === undefined) BotData.Groups[GroupName] = [];
			return BotData.Groups[GroupName].push(ChannelName);
		},
		AddGroup: function(GroupName) {
			return BotData.Groups[GroupName] = [];
		},
		RemoveGroup: function(GroupName) {
			return delete BotData.Groups[GroupName];
		},
		SaveChannels: function() {
			return BotFunctions.ConfigHandler.SaveConfig('groups', BotData.Groups);
		},
		Load: function() {
			return BotData.Groups = BotFunctions.ConfigHandler.GetConfig('groups');
		},
		In: function(GroupName, ChannelName) {
			if(BotData.Groups[GroupName] === undefined) {
				return false;
			}

			return BotData.Groups[GroupName].indexOf(ChannelName) === -1 ? false : true;
		}
	},
	Git: {
		Set: function(GitInfo) {
			return BotData.Git = GitInfo;
		},
		Get: function() {
			return BotData.Git;
		},
		Save: function() {
			return BotFunctions.ConfigHandler.SaveConfig('git', BotData.Git);
		},
		Load: function() {
			return BotData.Git = BotFunctions.ConfigHandler.GetConfig('git', BotData.Git);
		}
	},
	Express: {
		GetRoute: function() {
			return app.routes;
		},
		SetRoute: function(type, route, routeFunction) {
			if(type == 'get') {
				app.get(route, routeFunction);
			} else {
				app.post(route, routeFunction);
			}
		}
	},
	Permissions: {
		AddGroup: function(GroupName) {
			return BotData.Permissions[GroupName] = [];
		},
		RemoveGroup: function(GroupName) {
			delete BotData.Permissions[GroupName];
		},
		AddToGroup: function(GroupName, NickServName) {
			return BotData.Permissions[GroupName].push(NickServName);
		},
		RemoveFromGroup: function(GroupName, NickServName) {
			return BotData.Permissions[GroupName].remove(NickServName);
		},
		IsGroup: function(GroupName, NickServName) {
			return BotData.Permissions[GroupName].indexOf(NickServName) > -1;
		},
		Save: function() {
			return BotFunctions.ConfigHandler.SaveConfig('perm', BotData.Permissions);
		},
		Load: function() {
			return BotData.Permissions = BotFunctions.ConfigHandler.GetConfig('perm', BotData.Permissions);
		}
	},
	UsageLog: usageLog,
	SystemLog: sysLog
};

var InitDataStores = function() {
	BotFunctions.Global.LoadAllData();
	BotFunctions.Groups.Load();
	BotFunctions.Admins.Load();
	BotFunctions.Banned.Load();
	BotFunctions.Channels.Load();
	BotFunctions.Git.Load();
	BotFunctions.Permissions.Load();

	setTimeout(function() {
		BotFunctions.Global.SaveAllData();
	}, 60000);
};

var MainMessageHandler = function(from, to, message, info, Module, callback) {
	// Trigger Object filled with information about where and why command was executed
	var Trigger = {};

	// If it was a Query
	if(from == to) {
		// Set Trigger to say it is not from a channel
		Trigger.isChannel = false;
	} else {
		// Set Trigger to say it is from a channel
		Trigger.isChannel = true;
	}

	// Check if it is allowed to be called from this location
	if(Module.Places.indexOf((Trigger.isChannel) ? 'channel' : 'pm') === -1) {
		callback();
		return;
	}

	// If it is a channel
	if(Trigger.isChannel) {
		// If it should not be called in every channel
		if(Module.Channels !== true) {
			// Variable for looping
			ShouldBeCalled = false;
			// Loop through all groups
			for(var i = 0; i < Module.Channels.length; i++) {
				// Temp variable for holding the group name
				var group = Module.Channels[i];

				// Check if the group exists, and if it exists, if the channel is in it
				if(BotFunctions.Groups.In(group, to)) {
					// It is, so it should be called
					ShouldBeCalled = true;
					// We don't need to check any more, so break the loop
					break;
				}
			}

			// This isn't the right channel, so don't call it
			if(!ShouldBeCalled) {
				callback();
				return;
			}
		}
	}

	Trigger.args = Module.Command.exec(message);

	Trigger.from = from;
	Trigger.to = to;
	Trigger.message = message;
	Trigger.rawInfo = info;

	Module.RunFunction(Trigger, {
		reply: function(line) {
			if(Trigger.isChannel) {
				if(typeof line == 'string') {
					return from + ': ' + line;
				} else {
					var lines = [];
					for(var i = 0; i < line.length; i++) {
						lines.push(from + ': ' + line[i]);
					}
					return lines;
				}
			} else {
				return line;
			}
		}
	}, client, function(err, output) {
		if(err) {
			client.say(to, 'Error: ' + err);
			callback();
			return console.error(err);
		}

		if(output != null || output != undefined) {
			if(typeof output == 'string') {
				client.say(to, output);
			} else {
				for(var i = 0; i < output.length; i++) {
					client.say(to, output[i]);
				}
			}
		}

		callback();
	});
};

var HandleMessage = function(from, to, message, info) {
	// Async loop over all modules, for speed
	async.each(Modules, function(Module, callback) {
		// Test to see if it matches the RegExp
		if(!Module.Command.test(message)) {
			callback();
			return;
		}

		if(BotFunctions.Banned.Is(from)) {
			callback();
			return;
		}

		if(Module.Permissions) {
			BotFunctions.Global.GetNickServ(from, function(result) {
				if(BotFunctions.Permissions.IsGroup(Module.Permissions, result)) {
					MainMessageHandler(from, to, message, info, Module, callback);
				}
			});
		} else {
			MainMessageHandler(from, to, message, info, Module, callback);
		}
	});
};

var MainJoinHandler = function(channel, nick, info, Module, callback) {
	Module.RunFunction({
		channel: channel,
		nick: nick,
		rawInfo: info
	}, client, function(err, output) {
		if(err) {
			client.say(channel, 'Error: ' + err);
			callback();
			return console.error(err);
		}

		if(output !== null || output !== undefined) {
			if(typeof output == 'string') {
				client.say(channel, output);
			} else {
				for(var i = 0; i < output.length; i++) {
					client.say(channel, output[i]);
				}
			}
		}

		callback();
	});
}

var HandleJoin = function(channel, nick, info) {
	// Async loop over all join handlers, for speed
	async.each(Joins, function(Module, callback) {
		// Test to see if it matches the RegExp
		if(BotFunctions.Banned.Is(nick)) {
			callback();
			return;
		}

		if(Module.AdminOnly) {
			BotFunctions.Admins.Is(nick, function(result) {
				if(!result) {
					return callback();
				} else {
					MainJoinHandler(channel, nick, info, Module, callback);
				}
			});
		} else {
			MainJoinHandler(channel, nick, info, Module, callback);
		}
	});
};

var InitListeners = function() {
	client.addListener('message', function(from, to, message, info) {
		HandleMessage(from, to, message, info);
	});

	client.addListener('pm', function(from, message, info) {
		HandleMessage(from, from, message, info);
	});

	client.addListener('join', function(channel, nick, info) {
		HandleJoin(channel, nick, info);
	});

	client.addListener('error', function() {
		console.error('IRC error');
	});
};

var LoadModules = function(callback) {
	Modules = [];
	var scripts = fs.readdirSync('modules');
	if(scripts) {
		for(var i = 0; i < scripts.length; i++) {
			var script = fs.readFileSync('modules/' + scripts[i]);
			if(script) {
				var ScriptName = scripts[i];
				var sandbox = {
					console: console,
					require: require,
					syer: BotFunctions,
					RegisterCommand: function(command) {
						var BuiltCommand = {};

						BuiltCommand.Name = command.Name;

						if(command.Command.Type != 'regex') {
							BuiltCommand.CommandKey = command.Command.Key;
							BuiltCommand.Command = RegexBuilder(command.Command.Type, command.Command.Key);
						} else {
							BuiltCommand.Command = command.Command.regex;
						}

						if(command.Run.Places === undefined) {
							BuiltCommand.Places = ['channel', 'pm'];
						} else {
							BuiltCommand.Places = command.Run.Places;
						}

						if(command.Run.Channels === undefined) {
							BuiltCommand.Channels = true;
						} else {
							BuiltCommand.Channels = command.Run.Channels;
						}

						if(command.Run.Users === undefined) {
							BuiltCommand.Users = true;
						} else {
							BuiltCommand.Users = command.Run.Users;
						}

						BuiltCommand.Permissions = command.Run.RequiredPermission;

						BuiltCommand.Help = command.Help.Text;
						BuiltCommand.HelpExample = command.Help.Example;

						BuiltCommand.RunFunction = command.RunFunction;

						Modules.push(BuiltCommand);
					},
					RegisterJoin: function(joinHandler) {
						Joins.push(joinHandler);
					},
					AddRoute: function(type, route, func) {
						BotFunctions.Express.SetRoute(type, route, func);
					}
				}
				try {
					vm.runInNewContext(script, sandbox, scripts[i]);
				} catch (e) {
					console.error('Error loading script ' + scripts[i] + ': ' + e);
				}
			}
		}

		if(typeof(callback) == 'function') {
			callback();
		}
	}
};

LoadModules(function() {
	InitListeners();
	InitDataStores();
});