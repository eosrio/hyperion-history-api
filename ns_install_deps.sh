#!/usr/bin/env bash
set -eo pipefail

#variables
INITIAL_PARAMS="$*"
GLOBAL="y"
RABBIT_USER="admin"
RABBIT_PASSWORD="Fwsvajbv!MvJuf6aes"
NODE=false
REDIS=false
RABBIT=false
RAM=0

check_ram() {
  RAM=$(free --giga | awk '/Mem/ {print $2}')
}

# first check if is installed, after check version
check_dependencies() {
  CMD=$(if (dpkg --compare-versions $(dpkg -s nodejs 2>/dev/null | awk '/Version/ {print $2}') ge "5" 2>/dev/null); then echo true; else echo false; fi)
  if ("$CMD" = true); then
    NODE=true
  elif ("$CMD" = false); then
    exit 1
  else
    echo -e "\n\n"
  fi
  CMD=$(if (dpkg --compare-versions $(dpkg -s redis-server 2>/dev/null | awk '/Version/ {print $2}') ge "5" 2>/dev/null); then echo true; else echo false; fi)
  if ("$CMD" = true); then
    REDIS=true
  elif ("$CMD" = false); then
    exit 1
  else
    echo -e "\n"
  fi
  CMD=$(if (dpkg --compare-versions $(dpkg -s rabbitmq-server 2>/dev/null | awk '/Version/ {print $2}') ge "3.8" 2>/dev/null); then echo true; else echo false; fi)
  if ("$CMD" = true); then
    RABBIT=true
  elif ("$CMD" = false); then
    exit 1
  else
    echo -e "\n"
  fi
}

# Make a directory for global installations
configure_npm() {
  mkdir ~/.npm-global
  npm config set prefix "$HOME/.npm-global"
  # export path for the current session
  export PATH=$HOME/.npm-global/bin:$PATH
  # make PATH persistent
  echo "export PATH=~/.npm-global/bin:$PATH" >>"$HOME/.profile"
  # shellcheck source=/dev/null
  source ~/.profile
}

install_keys_sources() {
  PPA="https://artifacts.elastic.co/packages/7.x/apt stable main"
  if ! grep -q "^deb .*$PPA" /etc/apt/sources.list /etc/apt/sources.list.d/*; then
    wget -qO - https://artifacts.elastic.co/GPG-KEY-elasticsearch | sudo apt-key add -
    echo "deb https://artifacts.elastic.co/packages/7.x/apt stable main" | sudo tee -a /etc/apt/sources.list.d/elastic-7.x.list
  fi

  sudo apt-get install curl gnupg apt-transport-https -y

  ## Team RabbitMQ's main signing key
  curl -1sLf "https://keys.openpgp.org/vks/v1/by-fingerprint/0A9AF2115F4687BD29803A206B73A36E6026DFCA" | sudo gpg --dearmor | sudo tee /usr/share/keyrings/com.rabbitmq.team.gpg > /dev/null
  ## Cloudsmith: modern Erlang repository
  curl -1sLf https://dl.cloudsmith.io/public/rabbitmq/rabbitmq-erlang/gpg.E495BB49CC4BBE5B.key | sudo gpg --dearmor | sudo tee /usr/share/keyrings/io.cloudsmith.rabbitmq.E495BB49CC4BBE5B.gpg > /dev/null
  ## Cloudsmith: RabbitMQ repository
  curl -1sLf https://dl.cloudsmith.io/public/rabbitmq/rabbitmq-server/gpg.9F4587F226208342.key | sudo gpg --dearmor | sudo tee /usr/share/keyrings/io.cloudsmith.rabbitmq.9F4587F226208342.gpg > /dev/null

  ## Add apt repositories maintained by Team RabbitMQ
  sudo tee /etc/apt/sources.list.d/rabbitmq.list <<EOF
  ## Provides modern Erlang/OTP releases
  ##
  deb [signed-by=/usr/share/keyrings/io.cloudsmith.rabbitmq.E495BB49CC4BBE5B.gpg] https://dl.cloudsmith.io/public/rabbitmq/rabbitmq-erlang/deb/ubuntu bionic main
  deb-src [signed-by=/usr/share/keyrings/io.cloudsmith.rabbitmq.E495BB49CC4BBE5B.gpg] https://dl.cloudsmith.io/public/rabbitmq/rabbitmq-erlang/deb/ubuntu bionic main
  ## Provides RabbitMQ
  ##
  deb [signed-by=/usr/share/keyrings/io.cloudsmith.rabbitmq.9F4587F226208342.gpg] https://dl.cloudsmith.io/public/rabbitmq/rabbitmq-server/deb/ubuntu bionic main
  deb-src [signed-by=/usr/share/keyrings/io.cloudsmith.rabbitmq.9F4587F226208342.gpg] https://dl.cloudsmith.io/public/rabbitmq/rabbitmq-server/deb/ubuntu bionic main
EOF

## Update package indices
sudo apt-get update -y

## Install Erlang packages
sudo apt-get install -y erlang-base \
                        erlang-asn1 erlang-crypto erlang-eldap erlang-ftp erlang-inets \
                        erlang-mnesia erlang-os-mon erlang-parsetools erlang-public-key \
                        erlang-runtime-tools erlang-snmp erlang-ssl \
                        erlang-syntax-tools erlang-tftp erlang-tools erlang-xmerl

## Install rabbitmq-server and its dependencies
sudo apt-get install rabbitmq-server -y --fix-missing

  PPA="https://deb.nodesource.com/node_16.x bionic main"
  if ! grep -q "^deb .*$PPA" /etc/apt/sources.list /etc/apt/sources.list.d/*; then
    curl -sL "https://deb.nodesource.com/setup_16.x" | sudo -E bash -
  fi

  sudo apt update -y
}

install_dep() {
  sudo apt install -y curl
}

install_node() {
  sudo apt install -y nodejs
  if [ ! -d ~/.npm-global ]; then
    configure_npm
  fi
}

install_build_hyperion() {
  npm install
}

install_pm2() {
  if [ "$GLOBAL" = "y" ]; then
    npm install pm2@latest -g
  else
    sudo npm install pm2@latest -g
  fi
}

install_redis() {
  sudo apt install -y redis-server
  sudo sed -ie 's/supervised no/supervised systemd/' /etc/redis/redis.conf
  sudo systemctl restart redis.service
}

install_erlang() {
  sudo apt -y install erlang
}

install_rabittmq() {
  echo -e "\n\n\n\n"
  sudo apt install -y rabbitmq-server
  #enable web gui
  sudo rabbitmq-plugins enable rabbitmq_management
  sudo rabbitmqctl add_vhost /hyperion
  sudo rabbitmqctl add_user ${RABBIT_USER} ${RABBIT_PASSWORD}
  sudo rabbitmqctl set_user_tags ${RABBIT_USER} administrator
  sudo rabbitmqctl set_permissions -p /hyperion ${RABBIT_USER} ".*" ".*" ".*"
}

#******************
# End of functions
#******************
check_dependencies

install_dep

install_keys_sources
if [ "$NODE" = false ]; then
  install_node
fi

install_pm2

install_build_hyperion

if [ "$RABBIT" = false ]; then
  install_rabittmq
fi

if [ "$REDIS" = false ]; then
  install_redis
fi

printf "
 _   ___   ______  _____ ____  ___ ___  _   _
| | | \ \ / /  _ \| ____|  _ \|_ _/ _ \| \ | |
| |_| |\ V /| |_) |  _| | |_) || | | | |  \| |
|  _  | | | |  __/| |___|  _ < | | |_| | |\  |
|_| |_| |_| |_|   |_____|_| \_\___\___/|_| \_|
Stolen with ♥ from EOS Rio
"