const actionExtras = new Map();
const chain = process.env.CHAIN;

actionExtras.set(`${chain}"::eosio::newaccount`,(action) => {
	let name = null;
	const data = action['act']['data'];
	if (data['newact']) {
		name = data['newact'];
	} else if (data['name']) {
		name = data['name'];
		delete action['act']['data']['name'];
	}
	if (name) {
		action['act']['data']['newact'] = String(name);
		action['@newaccount'] = {
			active: data['active'],
			owner: data['owner']
		}
	}
});

actionExtras.set(`${chain}"::*::transfer`,(action) => {
	let qtd = null;
	const data = action['act']['data'];
	if(data['quantity']) {
		qtd = data['quantity'].split(' ');
	} else if(data['value']) {
		qtd = data['value'].split(' ');
	}
	action['act']['data']['from'] = String(data['from']);
	action['act']['data']['to'] = String(data['to']);
	if(qtd) {
		action['act']['data']['amount'] = parseFloat(qtd[0]);
		action['act']['data']['symbol'] = qtd[1];
	}
});

module.exports = {actionExtras}