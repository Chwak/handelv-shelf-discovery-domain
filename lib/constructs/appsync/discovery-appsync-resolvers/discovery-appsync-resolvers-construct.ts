import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface DiscoveryAppSyncResolversConstructProps {
  api: appsync.IGraphqlApi;
  searchProductsLambda?: lambda.IFunction;
  interpretCollectorQueryLambda?: lambda.IFunction;
  generateFeedLambda?: lambda.IFunction;
  generateRecommendationsLambda?: lambda.IFunction;
  getCuratedCollectionLambda?: lambda.IFunction;
  updateSearchIndexLambda?: lambda.IFunction;
}

export class DiscoveryAppSyncResolversConstruct extends Construct {
  constructor(scope: Construct, id: string, props: DiscoveryAppSyncResolversConstructProps) {
    super(scope, id);

    if (props.searchProductsLambda) {
      const searchProductsDataSource = props.api.addLambdaDataSource(
        'SearchProductsDataSource',
        props.searchProductsLambda
      );

      searchProductsDataSource.createResolver('SearchProductsResolver', {
        typeName: 'Query',
        fieldName: 'searchShelfItems',
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      });
    }

    if (props.interpretCollectorQueryLambda) {
      const interpretCollectorQueryDataSource = props.api.addLambdaDataSource(
        'InterpretCollectorQueryDataSource',
        props.interpretCollectorQueryLambda
      );

      interpretCollectorQueryDataSource.createResolver('InterpretCollectorQueryResolver', {
        typeName: 'Query',
        fieldName: 'interpretCollectorQuery',
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      });
    }

    if (props.generateFeedLambda) {
      const generateFeedDataSource = props.api.addLambdaDataSource(
        'GenerateFeedDataSource',
        props.generateFeedLambda
      );

      generateFeedDataSource.createResolver('GenerateFeedResolver', {
        typeName: 'Mutation',
        fieldName: 'generateFeed',
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      });
    }

    if (props.generateRecommendationsLambda) {
      const generateRecommendationsDataSource = props.api.addLambdaDataSource(
        'GenerateRecommendationsDataSource',
        props.generateRecommendationsLambda
      );

      generateRecommendationsDataSource.createResolver('GenerateRecommendationsResolver', {
        typeName: 'Mutation',
        fieldName: 'generateRecommendations',
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      });
    }

    if (props.getCuratedCollectionLambda) {
      const getCuratedCollectionDataSource = props.api.addLambdaDataSource(
        'GetCuratedCollectionDataSource',
        props.getCuratedCollectionLambda
      );

      getCuratedCollectionDataSource.createResolver('GetCuratedCollectionResolver', {
        typeName: 'Query',
        fieldName: 'getCuratedCollection',
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      });
    }

    if (props.updateSearchIndexLambda) {
      const updateSearchIndexDataSource = props.api.addLambdaDataSource(
        'UpdateSearchIndexDataSource',
        props.updateSearchIndexLambda
      );

      updateSearchIndexDataSource.createResolver('UpdateSearchIndexResolver', {
        typeName: 'Mutation',
        fieldName: 'updateShelfItemIndex',
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      });
    }
  }
}
