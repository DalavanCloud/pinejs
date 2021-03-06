import * as webpack from 'webpack';
import * as _ from 'lodash';
import sharedConfig = require('./config');
const config = _.clone(sharedConfig);

const root = config.entry;
config.entry = root + '/src/server-glue/server';

// Disable node express and load express-emulator instead
config.externals['express'] = false;
if (config.resolve.alias == null) {
	config.resolve.alias = {};
}
config.resolve.alias.express = root + '/src/express-emulator/express';

config.plugins = config.plugins.concat(
	new webpack.DefinePlugin({
		'process.browser': true,
		'process.env.CONFIG_LOADER_DISABLED': true,
		'process.env.DEBUG': true,
		'process.env.SBVR_SERVER_ENABLED': true,
	}),
);

export = config;
