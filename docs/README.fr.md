# GPUChain

[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md)

Le réseau principal public `gpuchain-mainnet-1` est exploité à l’échelle d’un projet pilote. Sa promotion signée conserve le hachage de genèse, les portefeuilles, les soldes et les numéros de séquence initiaux. Exécutez `node src/cli.mjs verify` pour vérifier que `networkStage` vaut `mainnet`. Le fichier de genèse conserve son nom historique `sites-testnet.json` pour les clients existants.

**Transmettez l’URL de ce dépôt à un agent pour lancer un nœud de vérification du réseau principal public en arrière-plan.** Vous pouvez aussi cloner le dépôt et exécuter `npm start` avec Node.js 24 ou une version ultérieure. Le nœud crée ou réutilise son portefeuille et sa base de données, vérifie régulièrement les points de contrôle signés et conserve le dernier état vérifié. Il continue de fonctionner après la fermeture du terminal ou de la session de l’agent. Cette participation fonctionne sans GPU, sans téléchargement de modèle et sans adresse IP publique. [Guide pour les agents](../AGENTS.md) · [Exploitation du réseau principal](../hosting/sites/README.md)

Utilisez `npm run status` pour consulter la hauteur vérifiée et le statut de vote du nœud local. `npm stop` l’arrête et `npm start` le relance avec les mêmes données. Pour vérifier ponctuellement la connexion et les fournisseurs d’inférence, utilisez `npm run join`.

**Ouvrir le portefeuille.** Exécutez `npm run gui`, ou double-cliquez sur **GPUChain Wallet.cmd** sous Windows. Le lanceur démarre le nœud ou réutilise l’instance existante, puis ouvre le navigateur. Le tableau de bord local affiche l’adresse publique, le solde du dernier point de contrôle vérifié, la synchronisation et le statut de vote du nœud, ainsi que l’état de l’adaptateur d’inférence local. L’interface écoute sur un port de bouclage distinct. La commande `node scripts/open-wallet.mjs --print-url` affiche son URL. Pour envoyer des coins, ouvrez `GPUChain Unlock.cmd` ou lancez `npm run wallet:unlock`, saisissez le code à usage unique sur ce PC, puis vérifiez le destinataire et le montant avant de confirmer.

Le portefeuille s’ouvre en anglais et propose cinq langues, dont le français. Utilisez `GPUChain Backup.cmd` pour créer une sauvegarde chiffrée et conservez le mot de passe de restauration séparément. La boutique publique vend 10 coins pour 1 USDT. Enregistrez l’adresse de réception GPUChain avant le paiement. [Guide d’achat](usdt-sales.md) · [Sauvegarde et restauration](wallet-backup.md)

Le premier démarrage après la mise à jour protège la clé existante du participant Windows avec DPAPI pour le compte courant. Gardez une sauvegarde chiffrée par mot de passe pour la restauration sur un autre ordinateur. Utilisez `node src/cli.mjs recover-settlement --wallet FICHIER` pour vérifier ou terminer un paiement en attente sans relancer l’inférence.

## Utiliser OpenCode depuis un autre ordinateur

Sur l’ordinateur qui demande l’inférence, installez Node.js 24 ou ultérieur et OpenCode 2.x, puis exécutez `npm run opencode:setup` dans le dépôt GPUChain. Rouvrez OpenCode et sélectionnez `gpuchain/qwen3.8-flash-next` avec `/models`. L’adresse de base est généralement `http://127.0.0.1:8792/v1` sur cet ordinateur. Conservez le fichier `opencode.token` sur place. Il autorise les requêtes payantes depuis le portefeuille du participant.

Alimentez ce portefeuille et choisissez un fournisseur distinct. Le texte, le raisonnement et les appels d’outils arrivent en continu. La passerelle exige le relais chiffré pour l’inférence à distance. Le moteur du fournisseur traite le contenu en clair. La passerelle privilégie le fournisseur de la même session ou du plus long préfixe de conversation compatible. Les informations de routage expirent 60 minutes après le dernier règlement réussi. Le moteur gère la durée de vie du cache KV. La remise dépend du nombre de jetons en cache mesuré et confirmé dans le reçu. Le registre public permet de découvrir les fournisseurs et d’acheminer les requêtes via le relais chiffré. Le port 8080 est réservé au moteur local du fournisseur. [Exemple de vérification du relais](../README.md#use-paid-inference-from-another-computer)

## Vérification du registre et vote

Chaque nœud vérifie les points de contrôle. Pour voter sur les transactions, il lui faut également un portefeuille autorisé et une origine HTTPS publique accessible. L’exploitant peut autoriser l’adresse publique du portefeuille avec `add-validator`. Les portefeuilles déjà inscrits comme fournisseurs sont aussi admissibles. Faites suivre le trafic HTTPS vers le port local (8790 par défaut), définissez `GPUCHAIN_VALIDATOR_ORIGIN`, puis redémarrez le nœud. Conservez ensemble le portefeuille et sa base dans leur répertoire de données d’origine, par défaut `~/.gpuchain/participant`.

Sites vérifie les signatures, les adresses et les identifiants de base de trois nœuds prêts, puis certifie le comité. Deux signatures de ses trois membres sont nécessaires pour confirmer les transactions. Les autres nœuds continuent de vérifier le registre. [Activation du comité et conditions d’exploitation](../hosting/sites/README.md)

## Tarification et changement d’époque

Le fournisseur doit charger **Qwen3.8-Flash-Next**, y compris une quantification compatible de ces poids, avec un contexte d’au moins **262 144 tokens (256K)**. Les caches K et V actifs doivent **chacun avoir une précision Q8 ou supérieure**. Des poids Q2_0 peuvent être utilisés avec un cache KV Q8. L’adaptateur vérifie le modèle, le contexte et le format du cache renvoyés par `/metrics` avant la génération et avant de signer le reçu.

| Usage | Crédits par million de tokens | Pris en compte pour l’époque |
| --- | ---: | --- |
| Entrée lue hors cache | 0,15 | Oui |
| Sortie générée | 0,47 | Oui |
| Entrée lue depuis le cache | 0,016 | Non |

Ces montants reprennent les valeurs numériques du tarif international de l’API QwenCloud. Le registre tient les soldes en unités entières, à raison d’un milliard d’unités par crédit. Par exemple, une requête de 64 tokens d’entrée, dont 32 lus depuis le cache, avec 10 tokens de sortie coûte **0,000010012 crédit**. Elle ajoute **42 tokens** au compteur du réseau. Le règlement débite le portefeuille du demandeur et crédite celui du fournisseur. Le fichier de genèse fixe la répartition initiale des crédits et les adresses autorisées à fournir le service. [Tarifs QwenCloud](https://docs.qwencloud.com/models/qwen3-8-flash#pricing)

Une époque se termine chaque fois que les fournisseurs cumulent ensemble **un milliard (1 000 000 000) de tokens d’entrée hors cache et de sortie**. Le séquenceur peut programmer un nouveau plafond de sortie par requête pour l’époque suivante. La requête qui fait franchir le seuil est réglée avec le plafond en vigueur, et les tokens excédentaires sont reportés sur l’époque suivante. La hauteur du registre augmente à chaque opération acceptée. Le numéro d’époque augmente à chaque tranche d’un milliard de tokens admissibles.

## Réseau de développement indépendant sous Windows

Pour créer votre réseau local, exécutez `node scripts/bootstrap.mjs`. Les commandes suivantes permettent aussi de démarrer chaque rôle séparément.

Utilisez Node.js 24 ou plus récent. Le fournisseur choisit `--engine ryzenstrata` (par défaut) ou `--engine strata` dans la commande `provider` ou dans `scripts/bootstrap.mjs`. Le modèle RYZENStrata par défaut est `qwen3.8-flash-next-q2_0`. Strata sélectionne le seul modèle chargé admissible. S’il y en a plusieurs, précisez `--model-id`. Configurez l’URL du moteur avec `--strata` et son authentification avec `STRATA_API_KEY`. [Strata](https://github.com/Niko1221/Strata) · [RYZENStrata](https://github.com/hanchangha1127/RYZENStrata)

Le nœud en cours d’exécution détecte Strata sur les ports locaux **8080 puis 8000** et relie le moteur admissible à `127.0.0.1:8789`. Le moteur peut démarrer après le nœud. La détection contrôle le modèle, le contexte de 256K et la précision KV sans charger le modèle ni générer de jetons. Utilisez `GPUCHAIN_STRATA_URL` pour choisir le moteur local et `GPUCHAIN_AUTO_PROVIDER=0` pour désactiver la détection. Redémarrez le nœud après modification.

Un fournisseur inscrit au registre peut servir des requêtes via le relais chiffré en HTTPS sortant, généralement sur le port 443. Il peut être rémunéré dès le règlement des inférences, y compris pendant le fonctionnement du séquenceur. Le relais fonctionne sans tunnel entrant, sans origine publique de validateur et sans siège au comité. Vérifiez les fournisseurs avec `routes --transport relay`. Sur le réseau public, `chat` utilise le relais chiffré par défaut. L’option explicite `--transport auto` privilégie la liaison directe. Le mode direct exige une origine HTTPS publiée qui transmet au port 8789. Chaque requête et réponse relayée est limitée à 8 MiB de JSON avant chiffrement. `GPUCHAIN_INFERENCE_RELAY=0` désactive le relais.

Le demandeur sélectionne `--reasoning-effort none|low|medium|high`. Les valeurs `max` et `xhigh` correspondent à `high`. `--reasoning-budget-tokens N` accepte un entier de 0 à `--max-output`. La valeur 0 supprime le plafond spécifique de réflexion du moteur. Pour désactiver la réflexion, utilisez `none` avec un budget nul ou omis. L’absence des deux options conserve les réglages du moteur. Les jetons de réflexion sont inclus dans le plafond et dans le décompte de sortie une seule fois.

**Pour une installation manuelle, créez le réseau et démarrez le séquenceur dans le terminal 1.** Créez les portefeuilles et le fichier de genèse une seule fois, dans un répertoire `.local` neuf. L’exemple attribue un crédit au demandeur. Chaque fichier de portefeuille contient une clé privée. Sur plusieurs machines, chaque participant conserve son propre portefeuille. Si vous avez déjà exécuté le script de démarrage, passez directement aux commandes du client dans le terminal 3.

~~~powershell
New-Item -ItemType Directory -Force .local | Out-Null
node src/cli.mjs wallet --out .local/sequencer.json
$user = node src/cli.mjs wallet --out .local/user.json | ConvertFrom-Json
$provider = node src/cli.mjs wallet --out .local/provider.json | ConvertFrom-Json
node src/cli.mjs genesis --wallet .local/sequencer.json --out .local/genesis.json --allocation "$($user.address)=1" --provider $provider.address
node src/cli.mjs node --genesis .local/genesis.json --wallet .local/sequencer.json --dir .local/ledger
~~~

**Dans le terminal 2, démarrez l’adaptateur du fournisseur.** Par défaut, il écoute sur le port local 8789 et le séquenceur sur le port 8787.

~~~powershell
node src/cli.mjs provider --genesis .local/genesis.json --wallet .local/provider.json
~~~

**Dans le terminal 3, envoyez une requête, consultez le solde et effectuez un virement.** La réponse contient le message de l’assistant, le décompte des tokens, le coût et la confirmation du séquenceur. L’option `--text-file FILE` permet de lire la question depuis un fichier encodé en UTF-8.

~~~powershell
$provider = (Get-Content -Raw .local/provider.json | ConvertFrom-Json).address
node src/cli.mjs chat --genesis .local/genesis.json --wallet .local/user.json --provider-url http://127.0.0.1:8789 --provider-address $provider --text "Comment fonctionne la fenêtre de contexte ?" --max-input 1024 --max-output 128
node src/cli.mjs balance --genesis .local/genesis.json --address $provider
node src/cli.mjs transfer --genesis .local/genesis.json --wallet .local/user.json --to $provider --coins 0.01
node src/cli.mjs status --genesis .local/genesis.json
~~~

Pour ajouter un nœud suiveur, ouvrez un terminal supplémentaire.

~~~powershell
node src/cli.mjs follower --genesis .local/genesis.json --upstream http://127.0.0.1:8787 --dir .local/follower --port 8788
~~~

Depuis un terminal libre, vous pouvez vérifier le point de contrôle signé de ce nœud, puis programmer un plafond de sortie de 8 192 tokens pour la prochaine époque.

~~~powershell
node src/cli.mjs verify --genesis .local/genesis.json --ledger http://127.0.0.1:8788
node src/cli.mjs settings --genesis .local/genesis.json --wallet .local/sequencer.json --max-output 8192
~~~

Pour rejoindre le réseau après sa création, le nouveau fournisseur crée un portefeuille sur sa machine et transmet son adresse publique à l’opérateur du séquenceur. L’opérateur saisit cette adresse dans son propre terminal et signe l’inscription avec le portefeuille du séquenceur.

~~~powershell
$newProviderAddress = Read-Host "Adresse publique du nouveau fournisseur"
$providerOrigin = Read-Host "Origine HTTPS du fournisseur"
node src/cli.mjs add-provider --genesis .local/genesis.json --wallet .local/sequencer.json --address $newProviderAddress --url $providerOrigin
~~~

Pour déployer plusieurs machines, distribuez le fichier de genèse par un canal de confiance, exposez les services distants en HTTPS et indiquez le registre avec `--ledger URL`. Le séquenceur peut modifier l’origine publiée d’un fournisseur avec `set-provider-endpoint --address ADDRESS --url URL` ou la retirer en remplaçant `--url URL` par `--withdraw`. Le démarrage local inscrit automatiquement l’adresse de bouclage du fournisseur.

La commande `node src/cli.mjs routes --genesis .local/genesis.json` classe les fournisseurs disponibles. Sans les deux options de fournisseur sur `chat`, le client sonde jusqu’à 64 candidats en trois secondes et vérifie la signature et la disponibilité de chacun sur la même chaîne. Il mesure jusqu’à trois allers-retours HTTP par candidat (HTTPS à distance) et envoie la question uniquement au fournisseur dont la latence médiane est la plus faible. Ce classement reflète la réactivité depuis la machine cliente. La distance géographique et le débit de génération peuvent donner des classements différents. Pour imposer un fournisseur, passez `--provider-url URL --provider-address ADDRESS`. Arrêtez le service avec Ctrl+C et redémarrez avec la même genèse, le même portefeuille et le même répertoire de registre.

## Vérification, conservation des données et confiance

Le demandeur signe notamment l’adresse du fournisseur, l’empreinte de la question, le numéro de séquence et les plafonds de tokens. Le fournisseur vérifie le solde du demandeur avant de transmettre sa question au moteur Strata choisi. Son reçu signé associe la requête, la réponse et les mesures d’utilisation. Le client contrôle ces éléments, contresigne le reçu et le soumet au séquenceur. Les portefeuilles et le séquenceur signent avec Ed25519.

Le séquenceur vérifie la dépense et met à jour SQLite dans une transaction atomique. La base conserve les derniers soldes, numéros de séquence, paramètres et compteurs, l’empreinte du dernier bloc, ainsi qu’une empreinte de 32 octets par époque terminée. Les détails des transactions et les reçus individuels servent uniquement au traitement en cours. Le fournisseur reçoit la question en clair et garde brièvement en mémoire sa dernière réponse pour permettre une nouvelle tentative.

Les nœuds suiveurs vérifient le point de contrôle signé du séquenceur en s’appuyant sur l’empreinte de genèse de confiance. Les données conservées ne permettent pas de rejouer l’historique transaction par transaction. Après activation, ils vérifient le certificat du comité et les signatures d’une majorité de ses membres. Le protocole suppose le respect des règles par les validateurs. Les mesures dépendent des attestations des deux parties. La preuve indépendante de l’exécution sur GPU et le consensus ouvert à tous restent à développer. Le paiement nécessite la signature finale du demandeur. Si celui-ci se déconnecte ou refuse de signer, une inférence déjà réalisée peut rester impayée.

## Tests et licence

~~~powershell
node --test
node src/cli.mjs --help
~~~

Le test d’intégration HTTP utilise un moteur Strata simulé pour vérifier sans GPU le règlement des inférences, la tarification du cache, les virements, la synchronisation des nœuds suiveurs et le contrôle des reçus. Le code est distribué sous [licence MIT](../LICENSE). Le [guide de démarrage en anglais](../README.md) se trouve à la racine du dépôt.
