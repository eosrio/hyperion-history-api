#!/usr/bin/env bash
#set -eo pipefail

#terminal colors
export COLOR_NC=$(tput sgr0) #No Color
export COLOR_RED=$(tput setaf 1)
export COLOR_GREEN=$(tput setaf 2)
export COLOR_YELLOW=$(tput setaf 3)
export COLOR_BLUE=$(tput setaf 4)

#variables
GLOBAL="y"
RABBIT_USER="hyperion"
RABBIT_PASSWORD="123456"
NODE=false
ELASTIC=false
REDIS=false
RABBIT=false
KIBANA=false
RAM=0

check_ram(){
  RAM=$(free --giga | awk '/Mem/ {print $2}')
}
#first check if is installed, after check version
check_dependecies(){
  echo -e "\n\n${COLOR_BLUE}Checking dependencies...${COLOR_NC}\n\n"
  CMD=$(if(dpkg --compare-versions 2> /dev/null $(dpkg -s  nodejs 2> /dev/null | awk '/Version/ {print $2}') ge "5"); then echo true; else echo false; fi)
  if("$CMD" = true); then
    NODE=true
    echo -e "\n\n${COLOR_BLUE}Nodejs compatible version already installed ${COLOR_NC}\n\n"
  elif("$CMD" = false); then
    echo -e "\n\n${COLOR_RED}Nodejs installed version is < 13. Please, update and try again. ${COLOR_NC}\n\n"
    exit 1
  else
    echo -e "\n\n${COLOR_BLUE}Nodejs not installed ${COLOR_NC}\n\n"
  fi
  CMD=$(if(dpkg --compare-versions 2> /dev/null $(dpkg -s  elasticsearch 2> /dev/null | awk '/Version/ {print $2}') ge "7.6"); then echo true; else echo false; fi)
  if("$CMD" = true); then
    ELASTIC=true
    echo -e "\n\n${COLOR_BLUE}Elasticsearch compatible version already installed ${COLOR_NC}\n\n"
  elif ("$CMD" = false); then
    echo -e "\n\n${COLOR_RED}Elasticsearch installed version is < 7.6. Please, update and try again. ${COLOR_NC}\n\n"
    exit 1
  else
    echo -e "\n\n${COLOR_BLUE}Elasticsearch not installed ${COLOR_NC}\n\n"
  fi
  CMD=$(if(dpkg --compare-versions 2> /dev/null $(dpkg -s  redis-server 2> /dev/null | awk '/Version/ {print $2}') ge "5"); then echo true; else echo false; fi)
  if("$CMD" = true); then
    REDIS=true
    echo -e "\n\n${COLOR_BLUE}Redis compatible version already installed ${COLOR_NC}\n\n"
  elif("$CMD" = false); then
    echo -e "\n\n${COLOR_RED}Redis installed version is < 5. Please, update and try again. ${COLOR_NC}\n\n"
    exit 1
  else
    echo -e "\n\n${COLOR_BLUE}Redis not installed ${COLOR_NC}\n\n"
  fi
  CMD=$(if(dpkg --compare-versions 2> /dev/null $(dpkg -s  rabbitmq-server 2> /dev/null | awk '/Version/ {print $2}') ge "3.8"); then echo true; else echo false; fi)
  if("$CMD" = true); then
    RABBIT=true
    echo -e "\n\n${COLOR_BLUE}RabbitMQ compatible version already installed ${COLOR_NC}\n\n"
  elif("$CMD" = false); then
    echo -e "\n\n${COLOR_RED}RabbitMQ installed version is < 3.8. Please, update and try again. ${COLOR_NC}\n\n"
    exit 1
  else
    echo -e "\n\n${COLOR_BLUE}RabbitMQ not installed ${COLOR_NC}\n\n"
  fi
  CMD=$(if(dpkg --compare-versions 2> /dev/null $(dpkg -s  kibana 2> /dev/null | awk '/Version/ {print $2}') ge "7.6"); then echo true; else echo false; fi)
  if("$CMD" = true); then
    RABBIT=true
    echo -e "\n\n${COLOR_BLUE}Kibana compatible version already installed ${COLOR_NC}\n\n"
  elif("$CMD" = false); then
    echo -e "\n\n${COLOR_RED}Kibana installed version is < 7.6. Please, update and try again. ${COLOR_NC}\n\n"
    exit 1
  else
    echo -e "\n\n${COLOR_BLUE}Kibana not installed ${COLOR_NC}\n\n"
  fi
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

  #export APT_KEY_DONT_WARN_ON_DANGEROUS_USAGE=1

  PPA="https://artifacts.elastic.co/packages/7.x/apt stable main"
  if ! grep -q "^deb .*$PPA" /etc/apt/sources.list /etc/apt/sources.list.d/*; then
    wget -qO - https://artifacts.elastic.co/GPG-KEY-elasticsearch | sudo apt-key add -
    echo "deb https://artifacts.elastic.co/packages/7.x/apt stable main" | sudo tee -a /etc/apt/sources.list.d/elastic-7.x.list
  fi

  KEY=$(apt-key list 2> /dev/null | grep erlang)
  if [[ ! $KEY ]]; then
    wget -O- https://packages.erlang-solutions.com/ubuntu/erlang_solutions.asc | sudo apt-key add -
  fi

  KEY=$(apt-key list 2> /dev/null | grep rabbitmq)
  if [[ ! $KEY ]]; then
    wget -O - "https://packagecloud.io/rabbitmq/rabbitmq-server/gpgkey" | sudo apt-key add -
  fi

  PPA="https://deb.nodesource.com/node_13.x bionic main"
  if ! grep -q "^deb .*$PPA" /etc/apt/sources.list /etc/apt/sources.list.d/*; then
    curl -sL "https://deb.nodesource.com/setup_13.x" | sudo -E bash -
  fi

  sudo apt update -y
}

install_dep(){
  echo -e "\n\n${COLOR_BLUE}Installing build essentials...${COLOR_NC}\n\n"
  sudo apt install -y build-essential curl
}

install_node(){
  echo -e "\n\n${COLOR_BLUE}Installing nodejs...${COLOR_NC}\n\n"
  sudo apt install -y nodejs
  read -p "Do you want to create a directory for npm global installations [Y/n] : " GLOBAL
  GLOBAL=${GLOBAL:-y}
  if [ "$GLOBAL" = "y" ]; then
    configure_npm
    npm install -g node-gyp
    npm install -g typescript
  else
    sudo npm install -g node-gyp
    sudo npm install -g typescript
  fi
}

install_build_hyperion(){
  echo -e "\n\n${COLOR_BLUE}Installing and building hyperion...${COLOR_NC}\n\n"
  npm install
}

install_pm2(){
  echo -e "\n\n${COLOR_BLUE}Installing pm2...${COLOR_NC}\n\n"
  if [ "$GLOBAL" = "y" ]; then
    npm install pm2@latest -g
  else
    sudo npm install pm2@latest -g
  fi
}

install_redis(){
  echo -e "\n\n${COLOR_BLUE}Installing redis...${COLOR_NC}\n\n"
  sudo apt install -y redis-server
  sudo sed -ie 's/supervised no/supervised systemd/' /etc/redis/redis.conf
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

check_dependecies
if [ "$RABBIT" = false ] ; then
  rabbit_credentials
fi
install_dep
install_keys_sources
if [ "$NODE" = false ] ; then
  install_node
fi
install_pm2
install_build_hyperion
if [ "$RABBIT" = false ] ; then
  install_earlang
  install_rabittmq
fi
if [ "$REDIS" = false ] ; then
  install_redis
fi
if [ "$ELASTIC" = false ] ; then
  install_elastic
  install_kibana
fi

printf "
 _   ___   ______  _____ ____  ___ ___  _   _
| | | \ \ / /  _ \| ____|  _ \|_ _/ _ \| \ | |
| |_| |\ V /| |_) |  _| | |_) || | | | |  \| |
|  _  | | | |  __/| |___|  _ < | | |_| | |\  |
|_| |_| |_| |_|   |_____|_| \_\___\___/|_| \_|
Made with ♥ by EOS Rio
"
echo -e "\n\n${COLOR_GREEN}Hyperion History API successfully installed!!${COLOR_NC}"
echo -e "\n${COLOR_YELLOW}Please, check your installation: ${COLOR_NC}"
echo -e "${COLOR_YELLOW}- Elastic: http://localhost:9200 ${COLOR_NC}"
echo -e "${COLOR_YELLOW}- Kibana: http://localhost:5601 ${COLOR_NC}"
echo -e "${COLOR_YELLOW}- RabbitMQ: http://localhost:15672 ${COLOR_NC}"
echo -e "${COLOR_YELLOW}- Make pm2 auto-boot at server restart: \$ pm2 startup ${COLOR_NC}\n"
