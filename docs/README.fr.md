# GPUChain

[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md)

GPUChain est un **réseau expérimental de crédits d’inférence, encore en développement**, pour Qwen3.8-Flash-Next. En exécutant RYZENStrata sur votre matériel, vous gagnez des crédits lorsque vous traitez les requêtes d’autres utilisateurs. Vous pouvez ensuite transférer ces crédits ou les dépenser auprès d’un autre fournisseur, même si votre GPU est éteint. Le réseau actuel comprend un séquenceur qui signe l’état du registre, des fournisseurs agréés et des nœuds suiveurs en lecture seule. [Projet RYZENStrata](https://github.com/hanchangha1127/RYZENStrata)

**Démarrage du réseau local en une commande, sur toutes les plateformes prises en charge.** Avec Node.js 24 ou une version ultérieure, exécutez `node scripts/bootstrap.mjs` à la racine du dépôt. Le script initialise les portefeuilles et le registre dans `.local/`, les réutilise au prochain démarrage et signale séparément si le registre et le fournisseur sont prêts. Il se connecte à une installation RYZENStrata existante, sans télécharger de modèle. Pour rejoindre un réseau existant, utilisez le fichier de genèse de confiance et l’adresse du registre fournis par son opérateur. [Guide d’installation et d’exécution](../AGENTS.md)

## Tarification et changement d’époque

Chaque fournisseur doit offrir une **fenêtre de contexte de 256 K (262 144 tokens)**. L’adaptateur vérifie le modèle chargé et la capacité annoncée par RYZENStrata. La somme des plafonds d’entrée et de sortie signés pour une requête doit tenir dans cette fenêtre. La facturation se fonde sur les tokens effectivement traités.

| Usage | Crédits par million de tokens | Pris en compte pour l’époque |
| --- | ---: | --- |
| Entrée lue hors cache | 0,15 | Oui |
| Sortie générée | 0,47 | Oui |
| Entrée lue depuis le cache | 0,016 | Non |

Ces montants reprennent les valeurs numériques du tarif international de l’API QwenCloud. Le registre tient les soldes en unités entières, à raison d’un milliard d’unités par crédit. Par exemple, une requête de 64 tokens d’entrée, dont 32 lus depuis le cache, avec 10 tokens de sortie coûte **0,000010012 crédit**. Elle ajoute **42 tokens** au compteur du réseau. Le règlement débite le portefeuille du demandeur et crédite celui du fournisseur. Le fichier de genèse fixe la répartition initiale des crédits et les adresses autorisées à fournir le service. [Tarifs QwenCloud](https://docs.qwencloud.com/models/qwen3-8-flash#pricing)

Une époque se termine chaque fois que les fournisseurs cumulent ensemble **un milliard (1 000 000 000) de tokens d’entrée hors cache et de sortie**. Le séquenceur peut programmer un nouveau plafond de sortie par requête pour l’époque suivante. La requête qui fait franchir le seuil est réglée avec le plafond en vigueur, et les tokens excédentaires sont reportés sur l’époque suivante. La hauteur du registre augmente à chaque opération acceptée. Le numéro d’époque augmente à chaque tranche d’un milliard de tokens admissibles.

## Exécution sous Windows

Utilisez Node.js 24 ou une version ultérieure. Exécutez les commandes PowerShell depuis la racine du dépôt. Le registre, les portefeuilles, le client et l’adaptateur utilisent les modules intégrés de Node.js. Le fournisseur doit disposer d’une instance RYZENStrata en cours d’exécution, avec le modèle chargé et la route `/v1/models` accessible. L’adresse par défaut du moteur est `http://127.0.0.1:8000/v1` et l’identifiant du modèle est `qwen3.8-flash-next-q2_0`. Les options `--strata` et `--model-id` permettent de les adapter à votre installation. Si le moteur exige une clé, définissez `STRATA_API_KEY` dans l’environnement du fournisseur.

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

Le demandeur signe notamment l’adresse du fournisseur, l’empreinte de la question, le numéro de séquence et les plafonds de tokens. Le fournisseur vérifie le solde du demandeur avant de transmettre sa question à RYZENStrata. Son reçu signé associe la requête, la réponse et les mesures d’utilisation. Le client contrôle ces éléments, contresigne le reçu et le soumet au séquenceur. Les portefeuilles et le séquenceur signent avec Ed25519.

Le séquenceur vérifie la dépense et met à jour SQLite dans une transaction atomique. La base conserve les derniers soldes, numéros de séquence, paramètres et compteurs, l’empreinte du dernier bloc, ainsi qu’une empreinte de 32 octets par époque terminée. Les détails des transactions et les reçus individuels servent uniquement au traitement en cours. Le fournisseur reçoit la question en clair et garde brièvement en mémoire sa dernière réponse pour permettre une nouvelle tentative.

Les nœuds suiveurs vérifient le point de contrôle signé du séquenceur en s’appuyant sur l’empreinte de genèse de confiance. Les données conservées ne permettent pas de rejouer l’historique transaction par transaction. Les participants font confiance au séquenceur pour l’ordre des opérations et l’intégrité des points de contrôle, ainsi qu’aux deux signataires pour l’exactitude des mesures. La preuve indépendante de l’exécution sur GPU et le consensus ouvert à tous restent à développer. Le paiement nécessite la signature finale du demandeur. Si celui-ci se déconnecte ou refuse de signer, une inférence déjà réalisée peut rester impayée.

## Tests et licence

~~~powershell
node --test
node src/cli.mjs --help
~~~

Le test d’intégration HTTP utilise un moteur Strata simulé pour vérifier sans GPU le règlement des inférences, la tarification du cache, les virements, la synchronisation des nœuds suiveurs et le contrôle des reçus. Le code est distribué sous [licence MIT](../LICENSE). Le [guide de démarrage en anglais](../README.md) se trouve à la racine du dépôt.
