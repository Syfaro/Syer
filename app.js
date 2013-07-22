var fs = require('fs')
  , vm = require('vm')
  , irc = require('irc')
  , async = require('async')
  , RegexBuilder = require('./regexBuilder');

var ircConfig = JSON.parse(fs.readFileSync('config/irc.json'));

var client = new irc.Client(ircConfig.server, ircConfig.nick, {
	channels: ircConfig.channels,
	debug: true
});

var Modules = [];

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
			return JSON.parse(fs.readFileSync('config/' + ConfigName.toLowerCase() + '.json'));
		},
		SaveConfig: function(ConfigName, Data) {
			return fs.writeFileSync('config/' + ConfigName.toLowerCase() + '.json', JSON.stringify(Data));
		}
	},
	Global: {
		GetAllData: function() {
			return BotData;
		},
		GetAllModules: function() {
			return Modules;
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
			return BotData.Groups[GroupName].push(ChannelName);
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
	}
};

var InitDataStores = function() {
	BotFunctions.Groups.Load();
	BotFunctions.Admins.Load();
	BotFunctions.Banned.Load();
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
				return from + ': ' + line;
			} else {
				return line;
			}
		}
	}, client, function(err, output) {
		if(err) {
			client.say(to, 'Error: ' + err);
			return console.error(err);
		}

		if(output !== null || output !== undefined) {
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

		if(Module.AdminOnly) {
			BotFunctions.Admins.Is(from, function(result) {
				if(!result) {
					return callback();
				} else {
					MainMessageHandler(from, to, message, info, Module, callback);
				}
			});
		} else {
			MainMessageHandler(from, to, message, info, Module, callback);
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

						BuiltCommand.AdminOnly = command.Run.Admin;

						BuiltCommand.Help = command.Help.Text;
						BuiltCommand.HelpExample = command.Help.Example;

						BuiltCommand.RunFunction = command.RunFunction;

						Modules.push(BuiltCommand);
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