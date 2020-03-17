#!/usr/bin/env bash
set -eo pipefail

#terminal colors
export COLOR_NC=$(tput sgr0) #No Color
export COLOR_RED=$(tput setaf 1)
export COLOR_GREEN=$(tput setaf 2)
export COLOR_YELLOW=$(tput setaf 3)
export COLOR_BLUE=$(tput setaf 4)

#variables
RABBIT_USER="hyperion"
RABBIT_PASSWORD="123456"
RAM=0

check_ram(){
  RAM=$(free --giga | awk '/Mem/ {print $2}')
}

# Make a directory for global installations
configure_npm(){
  mkdir ~/.npm-global
  npm config set prefix '~/.npm-global'
  #export path for the current session
  export PATH=~/.npm-global/bin:$PATH
  #make PATH persistent
  echo "export PATH=~/.npm-global/bin:$PATH" >> ~/.profile
  source ~/.profile
}

install_keys_sources(){
  echo -e "\n\n${COLOR_BLUE}Configuring keys and sources...${COLOR_NC}\n\n"
  wget -qO - https://artifacts.elastic.co/GPG-KEY-elasticsearch | sudo apt-key add -
  echo "deb https://artifacts.elastic.co/packages/7.x/apt stable main" | sudo tee -a /etc/apt/sources.list.d/elastic-7.x.list
  wget -O- https://packages.erlang-solutions.com/ubuntu/erlang_solutions.asc | sudo apt-key add -
  wget -O - "https://packagecloud.io/rabbitmq/rabbitmq-server/gpgkey" | sudo apt-key add -
  curl -sL "https://deb.nodesource.com/setup_13.x" | sudo -E bash -
  sudo apt update -y
}

install_dep(){
  echo -e "\n\n${COLOR_BLUE}Installing build essentials...${COLOR_NC}\n\n"
  sudo apt install -y build-essential curl
}

install_node(){
  echo -e "\n\n${COLOR_BLUE}Installing nodejs...${COLOR_NC}\n\n"
  sudo apt install -y nodejs
  configure_npm
  npm install -g node-gyp
  npm install -g typescript

}

install_build_hyperion(){
  echo -e "\n\n${COLOR_BLUE}Installing and building hyperion...${COLOR_NC}\n\n"
  npm install
  tsc

}

install_pm2(){
  echo -e "\n\n${COLOR_BLUE}Installing pm2...${COLOR_NC}\n\n"
  npm i pm2@latest -g
}

install_redis(){
  echo -e "\n\n${COLOR_BLUE}Installing redis...${COLOR_NC}\n\n"
  sudo apt install -y redis-server
  sudo systemctl restart redis.service
}

install_earlang(){
  echo -e "\n\n${COLOR_BLUE}Installing earlang...${COLOR_NC}\n\n"
  echo "deb https://packages.erlang-solutions.com/ubuntu bionic contrib" | sudo tee /etc/apt/sources.list.d/rabbitmq.list
  sudo apt update
  sudo apt -y install erlang
}
#ask user for rabbit credentials
rabbit_credentials(){
  read -p "Enter rabbitmq user [hyperion]: " RABBIT_USER
  RABBIT_USER=${RABBIT_USER:-hyperion}

  read -p "Enter rabbitmq password [123456]: " RABBIT_PASSWORD
  RABBIT_PASSWORD=${RABBIT_PASSWORD:-123456}

}

install_rabittmq(){
  echo -e "\n\n${COLOR_BLUE}Installing rabbit-mq...${COLOR_NC}\n\n"
  curl -s "https://packagecloud.io/install/repositories/rabbitmq/rabbitmq-server/script.deb.sh" | sudo bash
  sudo apt install -y rabbitmq-server
  #enable web gui
  sudo rabbitmq-plugins enable rabbitmq_management
  sudo rabbitmqctl add_vhost /hyperion
  sudo rabbitmqctl add_user ${RABBIT_USER} ${RABBIT_PASSWORD}
  sudo rabbitmqctl set_user_tags ${RABBIT_USER} administrator
  sudo rabbitmqctl set_permissions -p /hyperion ${RABBIT_USER} ".*" ".*" ".*"
}

install_elastic(){
  echo -e "\n\n${COLOR_BLUE}Installing elastic...${COLOR_NC}\n\n"
  sudo apt install -y elasticsearch

  echo -e "\n\n${COLOR_BLUE}Configuring elastic...${COLOR_NC}\n\n"

  # edit configs
  sudo sed -ie 's/#cluster.name: my-application/cluster.name: myCluster/; s/#bootstrap.memory_lock: true/bootstrap.memory_lock: true/' /etc/elasticsearch/elasticsearch.yml
  # set jvm options based on system RAM
  check_ram
  if [ "$RAM" -lt 20 ]; then
    let RAM=$RAM/2
    sudo sed -ie 's/-Xms1g/-Xms'"$RAM"'g/; s/-Xmx1g/-Xmx'"$RAM"'g/' /etc/elasticsearch/jvm.options
  else
    sudo sed -ie 's/-Xms1g/-Xms16g/; s/-Xmx1g/-Xmx16g/' /etc/elasticsearch/jvm.options
  fi
  sudo mkdir -p /etc/systemd/system/elasticsearch.service.d/
  echo -e "[Service]\nLimitMEMLOCK=infinity" | sudo tee /etc/systemd/system/elasticsearch.service.d/override.conf
  sudo systemctl daemon-reload
  sudo service elasticsearch start
  sudo systemctl enable elasticsearch

}

install_kibana(){
  echo -e "\n\n${COLOR_BLUE}Installing kibana...${COLOR_NC}\n\n"
  sudo apt install -y kibana
  sudo systemctl enable kibana
  sudo systemctl start kibana
}

echo -e "\n\n${COLOR_BLUE}*** STARTING HYPERION HISTORY API CONFIGURATION ***${COLOR_NC}\n\n"

rabbit_credentials
# install_dep
# install_keys_sources
install_node
install_pm2
# install_build_hyperion
# install_earlang
# install_rabittmq
# install_redis
# install_elastic
# install_kibana

printf "
 _   ___   ______  _____ ____  ___ ___  _   _
| | | \ \ / /  _ \| ____|  _ \|_ _/ _ \| \ | |
| |_| |\ V /| |_) |  _| | |_) || | | | |  \| |
|  _  | | | |  __/| |___|  _ < | | |_| | |\  |
|_| |_| |_| |_|   |_____|_| \_\___\___/|_| \_|"

echo -e "\n\n${COLOR_GREEN}Hyperion History API successfully installed!!${COLOR_NC}"
echo -e "\n${COLOR_YELLOW}Please, check your installation: ${COLOR_NC}"
echo -e "${COLOR_YELLOW}- Elastic: http://localhost:9200 ${COLOR_NC}"
echo -e "${COLOR_YELLOW}- Kibana: http://localhost:5601 ${COLOR_NC}"
echo -e "${COLOR_YELLOW}- RabbitMQ: http://localhost:15672 ${COLOR_NC}"
echo -e "${COLOR_YELLOW}- Make pm2 auto-boot at server restart: \$ pm2 startup ${COLOR_NC}"
